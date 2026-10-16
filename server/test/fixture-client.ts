// Regression-test client: uses real libsodium encryption and the public API.
// Existing authorization/task journeys can express readable scenarios while
// the server receives only encrypted content. Protocol/security tests use
// makeApp() from app.ts directly, without this client.
import sodium from 'libsodium-wrappers-sumo';
import { makeApp, CallOpts, CallResult } from './app.js';

export function makeClientApp() {
  const app = makeApp();
  const topicKeys = new Map<string, { id: string; key: Uint8Array }>();
  const encryptedFields = new Map<string, {topic: string; key: Uint8Array; json: boolean}>();
  const hex = (n: number) => sodium.to_hex(sodium.randombytes_buf(n));
  const bytes = (s: string) => sodium.from_string(s);
  const b64 = (v: Uint8Array) => sodium.to_base64(v, sodium.base64_variants.ORIGINAL);
  function seal(tid: string, text: string) {
    const k = topicKeys.get(tid)!;
    const mid = hex(16), nonce = sodium.randombytes_buf(24);
    const aad = bytes(`fh-msg-v1\0${tid}\0${k.id}\0${mid}`);
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes(text), aad, null, nonce, k.key);
    const wire = `fh1.${k.id}.${mid}.${b64(new Uint8Array([...nonce, ...ct]))}`;
    encryptedFields.set(wire, {topic:tid, key:new Uint8Array(k.key), json:false});
    return wire;
  }
  function display(value: any): any {
    if (typeof value === 'string' && encryptedFields.has(value)) {
      const field = encryptedFields.get(value)!;
      const [, kid, mid, blob] = value.split('.');
      const raw = sodium.from_base64(blob, sodium.base64_variants.ORIGINAL);
      const aad = bytes(`fh-msg-v1\0${field.topic}\0${kid}\0${mid}`);
      const text = sodium.to_string(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, raw.slice(24), aad, raw.slice(0,24), field.key));
      return field.json ? JSON.parse(text) : text;
    }
    if (Array.isArray(value)) return value.map(display);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,display(v)]));
    return value;
  }
  async function activate(tid: string, token: string) {
    const record = await app.call('GET', `/v2/topics/${tid}`, {token});
    const key = topicKeys.get(tid)!;
    const epoch = (record.body.topic.current_epoch || 0) + 1;
    if (epoch > 1) { key.id = hex(16); key.key = sodium.randombytes_buf(32); }
    const subject = display(record.body.topic.subject) as string;
    const directory = await app.call('GET', '/v2/agent-keys', {token});
    for (const participant of record.body.participants) {
      for (const agent of directory.body.keys.filter((a: any)=>a.member_id===participant.member_id)) {
        const plain = new Uint8Array([...bytes(tid),0,...sodium.from_hex(key.id),...key.key]);
        const envelope = b64(sodium.crypto_box_seal(plain,sodium.from_base64(agent.public_key,sodium.base64_variants.ORIGINAL)));
        const r = await app.call('POST',`/v2/topics/${tid}/envelopes`,{token,body:{member_id:agent.member_id,agent_label:agent.agent_label,key_id:key.id,envelope}});
        if(r.status!==201) return r;
      }
    }
    return app.call('POST',`/v2/topics/${tid}/keys/commit`,{token,body:{expected_epoch:epoch,key_id:key.id,commitment:sodium.to_hex(sodium.crypto_hash_sha256(key.key)),subject:seal(tid,subject)}});
  }
  async function call(method: string, path: string, opts: CallOpts = {}): Promise<CallResult> {
    await sodium.ready;
    const body: any = opts.body && typeof opts.body === 'object' ? structuredClone(opts.body) : opts.body;
    let pair: { publicKey: Uint8Array; privateKey: Uint8Array } | undefined;
    if(method==='POST' && /\/(redeem|accept)$/.test(path) && !path.includes('/transfer/')) {
      pair = sodium.crypto_box_keypair();
      if(body && !Object.hasOwn(body,'agent_public_key')) body.agent_public_key=b64(pair.publicKey);
    }
    const spawn=/^\/v2\/topics\/([^/]+)\/spawn$/.exec(path);
    let created: string | undefined, briefing: string | undefined;
    if(method==='POST' && (path==='/v2/topics' || spawn) && typeof body?.subject==='string' && !body.subject.startsWith('fh1.')) {
      created=hex(16);
      topicKeys.set(created,{id:hex(16),key:sodium.randombytes_buf(32)});
      if(body && typeof body.subject==='string' && !body.subject.startsWith('fh1.')) {
        body.topic_id=created;
        body.subject=seal(created,body.subject);
        if(spawn) { briefing=body.briefing; delete body.briefing; }
      }
    }
    const content=/^\/v2\/topics\/([^/]+)\/(entries|tasks)$/.exec(path);
    if(method==='POST' && content && body && topicKeys.has(content[1])) {
      const tid=content[1];
      if(content[2]==='entries' && (!body.kind || ['message','briefing'].includes(body.kind))) {
        if(typeof body.body==='string' && !body.body.startsWith('fh1.')) body.body=seal(tid,body.body);
        if(body.data!=null) {const value=body.data;body.data=seal(tid,JSON.stringify(value));encryptedFields.get(body.data)!.json=true;}
      }
      if(content[2]==='tasks') for(const field of ['title','description']) if(typeof body[field]==='string'&&!body[field].startsWith('fh1.')) body[field]=seal(tid,body[field]);
    }
    const task=/^\/v2\/tasks\/([^/]+)\/(notes|done)$/.exec(path);
    if(method==='POST' && task && body) {
      const row=await app.db.queryOne('SELECT topic_id FROM tasks WHERE id = ?',[task[1]]);
      const tid=row?.topic_id as string;
      if(topicKeys.has(tid)) {
        if(task[2]==='notes' && typeof body.body==='string') body.body=seal(tid,body.body);
        if(task[2]==='done' && body.result!=null) {const value=body.result;body.result=seal(tid,JSON.stringify(value));encryptedFields.get(body.result)!.json=true;}
      }
    }
    let result=await app.call(method,path,{...opts,body});
    if(created && result.status===201) {
      const activated=await activate(created,opts.token!);
      if(activated.status!==200)return activated;
      if(briefing) await call('POST',`/v2/topics/${created}/entries`,{token:opts.token,body:{kind:'briefing',body:briefing}});
    }
    if(method==='POST' && /\/invite$/.test(path) && result.status===200 && body.history_from==='from_join') {
      const tid=path.split('/')[3];
      if(topicKeys.has(tid))await activate(tid,opts.token!);
    }
    return {...result,body:display(result.body)};
  }
  return {...app,call,rawCall:app.call,seal,activate};
}

export type TestClientApp = ReturnType<typeof makeClientApp>;
