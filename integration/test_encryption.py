"""Production CLI + Worker integration. Run after `npm test` in server/."""
import contextlib
import http.client
import base64
import hashlib
from unittest import mock
from nacl.public import PrivateKey
from nacl import bindings
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_loader('integration_hub', SourceFileLoader('integration_hub',str(ROOT/'agent-skill/hub')))
hub=importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

class EncryptionJourney(unittest.TestCase):
    def setUp(self):
        self.saved=dict(os.environ)
        self.temp=tempfile.TemporaryDirectory()
        os.environ['FAMILY_HUB_CONFIG_HOME']=self.temp.name
        os.environ.pop('FAMILY_HUB_TOKEN',None)
        self.node=subprocess.Popen(['node',str(ROOT/'server/test/cli-driver.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
        hub._reset_server_version_cache()
    def tearDown(self):
        self.node.stdin.close()
        self.node.wait(timeout=5)
        self.node.stdout.close()
        self.temp.cleanup()
        os.environ.clear();os.environ.update(self.saved)
        hub.clear_secrets()
    def exchange(self,payload):
        self.node.stdin.write(json.dumps(payload)+'\n');self.node.stdin.flush()
        return json.loads(self.node.stdout.readline())
    def transport(self,method,url,headers,body):
        parsed=urlparse(url)
        response=self.exchange({'method':method,'path':parsed.path+('?' + parsed.query if parsed.query else ''),'headers':headers,'body':body.decode() if body else None})
        return response['status'],response['body']
    def api(self,method,path,body=None,token=None):
        headers={'Content-Type':'application/json'}
        if path.startswith('/v2/families/'):
            headers['X-Circle-ID']=path.split('/')[3]
        if token: headers['Authorization']='Bearer '+token
        code,text=self.transport(method,'https://hub.test'+path,headers,json.dumps(body).encode() if body is not None else None)
        return code,json.loads(text)
    def cli(self,profile,*args,expected=0):
        out,err=io.StringIO(),io.StringIO()
        with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err), mock.patch.object(hub.sys.stdin,"isatty",return_value=True), mock.patch.object(hub.getpass,"getpass",side_effect=lambda _:self.exchange({"mailbox":True})["code"]):
            rc=hub.main(['--profile',profile,*args],transport=self.transport)
        self.assertEqual(rc,expected,err.getvalue())
        return json.loads(out.getvalue()) if out.getvalue().lstrip().startswith(('{','[')) else out.getvalue()
    def setup_owner(self):
        code,result=self.api('POST','/v2/families',{'name':'Private circle','owner_name':'Owner','owner_email':'owner@example.test'})
        self.assertEqual(code,201)
        self.cli('owner','setup','--server','https://hub.test','--invite',result['provisioning_code'],'--store','file')
        return self.cli('owner','me')['member']['id']
    def join(self,name,role='parent'):
        owner_token=hub.load_token(hub.load_config('owner'),'owner')[0]
        fam=hub.load_config('owner')['family_id']
        code,inv=self.api('POST',f'/v2/families/{fam}/invites',{'email':name+'@example.test','role':role},owner_token)
        self.assertEqual(code,201)
        self.cli(name,'setup','--server','https://hub.test','--invite',inv['invite_code'],'--store','file','--name',name,'--label',name+'-agent')
        return self.cli(name,'me')['member']['id']
    def invitation(self, email, family=None):
        cfg = hub.load_config('owner')
        family = family or cfg['active_circle_id']
        token = hub.load_token(cfg, 'owner')[0]
        status, response = self.api('POST', '/v2/families/' + family + '/invites', {'email':email,'role':'parent'}, token)
        self.assertEqual(status, 201)
        return response

    def test_invited_enrollment_lost_response_resumes_without_new_code(self):
        self.setup_owner()
        invitation = self.invitation('person@example.test')
        code_file = Path(self.temp.name) / 'invite-code'
        code_file.write_text(invitation['invite_code'])
        original = self.transport
        statuses, credentials = [], []
        def unreliable(method, url, headers, body):
            result = original(method, url, headers, body)
            if url.endswith('/accept'):
                statuses.append(result[0])
                credentials.append(json.loads(body)['agent_token'])
                if len(statuses) == 1:
                    raise http.client.RemoteDisconnected('response interrupted')
            return result
        self.transport = unreliable
        with mock.patch.object(hub.time, 'sleep'):
            self.cli('person','enroll','--server','https://hub.test','--code-file',str(code_file),'--name','Person')
        self.assertEqual(statuses,[201,200])
        self.assertEqual(credentials[0],credentials[1])
        cfg=hub.load_config('person')
        self.assertEqual(hub.load_token(cfg,'person')[0],credentials[0])
        self.assertFalse(Path(hub._pending_enrollment('person')).exists())
        snapshot=json.loads(self.exchange({'snapshot':True})['body'])
        self.assertEqual(len(snapshot['members']),2)
        self.assertEqual(len(snapshot['agent_tokens']),2)
        self.assertEqual(self.cli('person','me')['member']['name'],'Person')

    def test_local_save_failure_resumes_from_private_journal_with_identity_intact(self):
        self.setup_owner()
        invitation=self.invitation('person@example.test')
        code_file=Path(self.temp.name)/'invite-code'
        code_file.write_text(invitation['invite_code'])
        write=hub._write_secret_file_0600
        def fail_credential(path,data,what):
            if what=='credential':
                raise OSError('injected credential persistence failure')
            return write(path,data,what)
        with mock.patch.object(hub,'_write_secret_file_0600',side_effect=fail_credential):
            self.cli('person','enroll','--server','https://hub.test','--code-file',str(code_file),'--name','Person',expected=1)
        journal=Path(hub._pending_enrollment('person'))
        self.assertTrue(journal.exists())
        self.assertEqual(journal.stat().st_mode & 0o777,0o600)
        identity=Path(hub.agent_key_path('person')).read_bytes()
        report=Path(self.temp.name)/'diagnostics.json'
        self.cli('person','diagnostics','export','--output',str(report))
        exported=report.read_text()
        pending=json.loads(journal.read_text())
        self.assertNotIn(pending['body']['agent_token'],exported)
        self.assertNotIn(invitation['invite_code'],exported)
        self.assertTrue(json.loads(exported)['pending_enrollment'])
        self.cli('person','enroll','--resume')
        self.assertEqual(Path(hub.agent_key_path('person')).read_bytes(),identity)
        self.assertFalse(journal.exists())
        snapshot=json.loads(self.exchange({'snapshot':True})['body'])
        self.assertEqual(len(snapshot['members']),2)
        self.assertEqual(len(snapshot['agent_tokens']),2)

    def test_joining_second_circle_preserves_first_credential_and_agent_label(self):
        self.setup_owner()
        first=hub.load_config('owner')['active_circle_id']
        inv=self.invitation('person@example.test',first)
        code=Path(self.temp.name)/'code'
        code.write_text(inv['invite_code'])
        self.cli('person','enroll','--server','https://hub.test','--code-file',str(code),'--name','Person','--label','first-agent')
        original=hub.load_token(hub.load_config('person'),'person')[0]
        self.exchange({'lock_setup':True})
        self.cli('owner','circle','create','--name','Second circle','--kind','general')
        second=hub.load_config('owner')['active_circle_id']
        inv=self.invitation('person@example.test',second)
        code.write_text(inv['invite_code'])
        self.cli('person','enroll','--server','https://hub.test','--code-file',str(code),'--name','Person','--label','second-agent')
        cfg=hub.load_config('person')
        self.assertEqual(hub.load_token(cfg,'person')[0],original)
        self.assertNotIn('circle_tokens',cfg)
        snapshot=json.loads(self.exchange({'snapshot':True})['body'])
        self.assertEqual(len([u for u in snapshot['principals'] if u['email']=='person@example.test']),1)
        self.assertEqual(len([a for a in snapshot['agents'] if a['user_id']==cfg['user']['id']]),1)
        circles=self.cli('person','circles')
        self.assertIn('Private circle',circles)
        self.assertIn('Second circle',circles)
        # The same server credential and agent identity work for encrypted
        # messages and tasks in the second circle, with its own member IDs.
        second_owner=self.cli('owner','me')['member']['id']
        second_person=self.cli('person','me')['member']['id']
        topic=self.cli('owner','new-topic','--subject','Hotel plan','--with',second_owner+','+second_person)['topic']['id']
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-HOTEL-MESSAGE')
        self.assertIn('PRIVATE-HOTEL-MESSAGE',json.dumps(self.cli('person','read','--topic',topic)))
        self.cli('person','post','--topic',topic,'--message','PRIVATE-HOTEL-REPLY')
        task=self.cli('owner','task-new','--topic',topic,'--title','PRIVATE-HOTEL-TASK','--assignee',second_person)['task']['id']
        self.cli('person','task-done','--topic',topic,'--task',task,'--result','{"done":true}')
        # Transfer/removal must preserve other circles and require topic rekey.
        self.cli('owner','circle','transfer','--to',second_person,'--on-complete','remove')
        self.cli('person','circle','transfer-accept')
        self.cli('person','post','--circle',second,'--topic',topic,'--message','PRIVATE-BLOCKED',expected=1)
        self.cli('person','topic-rekey','--circle',second,'--topic',topic)
        self.cli('person','post','--circle',second,'--topic',topic,'--message','PRIVATE-AFTER-TRANSFER')
        self.cli('owner','read','--circle',second,'--topic',topic,expected=1)
        self.cli('person','circle','use',first)
        self.assertEqual(self.cli('person','me')['member']['family_id'],first)
        self.assertEqual(hub.load_config('person')['agent_label'],'first-agent')
        self.cli('person','read','--topic',topic,expected=1)
        self.cli('owner','circle','use',first)
        owner_first=self.cli('owner','me')['member']['id']
        person_first=self.cli('person','me')['member']['id']
        topic_first=self.cli('owner','new-topic','--subject','Family plan','--with',owner_first+','+person_first)['topic']['id']
        self.cli('owner','post','--topic',topic_first,'--message','PRIVATE-FAMILY-MESSAGE')
        self.assertIn('PRIVATE-FAMILY-MESSAGE',json.dumps(self.cli('person','read','--topic',topic_first)))

    def test_own_agent_approval_installs_another_agent_without_email_prompt(self):
        self.setup_owner()
        approval=Path(self.temp.name)/'new-device-approval'
        result=self.cli('owner','agent-invite','--label','phone','--output',str(approval))
        self.assertEqual(result['agent_label'],'phone')
        with mock.patch.object(hub,'_read_email_verification_code',side_effect=AssertionError('Approved agent must not request another email proof')):
            self.cli('phone','enroll','--server','https://hub.test','--code-file',str(approval),'--label','phone')
        owner=hub.load_config('owner');phone=hub.load_config('phone')
        self.assertEqual(owner['user']['id'],phone['user']['id'])
        self.assertNotEqual(owner['agent']['id'],phone['agent']['id'])
        self.assertEqual(len(self.cli('phone','circles','--json')['data']['circles']),1)
        self.assertEqual(approval.stat().st_mode & 0o777,0o600)

    def test_replacement_agent_keeps_user_identity_without_inheriting_historical_keys(self):
        owner=self.setup_owner();person=self.join('person')
        topic=self.cli('owner','new-topic','--subject','Private history','--with',owner+','+person)['topic']['id']
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-HISTORICAL-CONTENT')
        original=hub.load_config('person')['user']['id']
        self.cli('replacement','enroll','--server','https://hub.test','--recover-email','person@example.test','--label','replacement-agent')
        self.assertEqual(hub.load_config('replacement')['user']['id'],original)
        self.assertEqual(hub._load_topic_keys('replacement',topic),{})
        received=self.cli('replacement','read','--topic',topic)
        self.assertNotIn('PRIVATE-HISTORICAL-CONTENT',json.dumps(received))
        self.assertIn('PRIVATE-HISTORICAL-CONTENT',json.dumps(self.cli('person','read','--topic',topic)))

    def test_rejoining_removed_circle_reuses_user_agent_and_server_credential(self):
        owner=self.setup_owner();member=self.join('person')
        user=hub.load_config('person')['user']['id']
        agent=hub.load_config('person')['agent']['id']
        token=hub.load_token(hub.load_config('person'),'person')[0]
        topic=self.cli('owner','new-topic','--subject','Before removal','--with',owner+','+member)['topic']['id']
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-BEFORE-REMOVAL')
        self.cli('owner','circle','remove-member','--member',member)
        self.assertEqual(self.cli('person','circles','--json')['data']['circles'],[])
        inv=self.invitation('person@example.test')
        code=Path(self.temp.name)/'rejoin-code';code.write_text(inv['invite_code'])
        self.cli('person','enroll','--server','https://hub.test','--code-file',str(code),'--name','Person')
        cfg=hub.load_config('person')
        self.assertEqual(cfg['user']['id'],user)
        self.assertEqual(cfg['agent']['id'],agent)
        self.assertEqual(hub.load_token(cfg,'person')[0],token)
        self.assertNotEqual(self.cli('person','me')['member']['id'],member)
        self.cli('person','read','--topic',topic,expected=1)

    def test_family_tasks_child_history_rotation_and_storage(self):
        owner=self.setup_owner();partner=self.join('partner');child=self.join('child','kid')
        topic=self.cli('owner','new-topic','--subject','PRIVATE-PICKUP-PLAN','--with',owner+','+partner)['topic']['id']
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-COLLECT-AT-FIVE')
        received=self.cli('partner','read','--topic',topic)
        self.assertIn('PRIVATE-COLLECT-AT-FIVE',json.dumps(received))
        tasks=self.cli('owner','task-new','--topic',topic,'--title','PRIVATE-CHECK-SUPPLIES','--assignee',partner)
        task=tasks['task']['id']
        self.cli('partner','task-note','--topic',topic,'--task',task,'--message','PRIVATE-NOTE')
        self.cli('partner','task-done','--topic',topic,'--task',task,'--result','{"answer":"PRIVATE-RESULT"}')
        listed=self.cli('owner','tasks','--topic',topic)
        self.assertEqual(listed[0]['title'],'PRIVATE-CHECK-SUPPLIES')
        self.assertEqual(listed[0]['result'],{'answer':'PRIVATE-RESULT'})
        kidtopic=self.cli('owner','spawn','--topic',topic,'--subject','PRIVATE-CHILD-PLAN','--with',owner+','+child,'--briefing','PRIVATE-APPROVED-BRIEFING')['topic']['id']
        kidread=self.cli('child','read','--topic',kidtopic)
        self.assertIn('PRIVATE-APPROVED-BRIEFING',json.dumps(kidread))
        self.cli('child','read','--topic',topic,expected=1)
        # The parent topic key was not shared with the child.
        self.assertEqual(hub._load_topic_keys('child',topic),{})
        newcomer=self.join('newcomer')
        self.cli('owner','invite','--topic',topic,'--member',newcomer,'--history','from-join')
        # Membership changes block content until the new epoch commits.
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-BLOCKED',expected=1)
        self.cli('owner','topic-rekey','--topic',topic)
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-NEW-EPOCH')
        newread=self.cli('newcomer','read','--topic',topic)
        self.assertIn('PRIVATE-NEW-EPOCH',json.dumps(newread))
        self.assertNotIn('PRIVATE-COLLECT-AT-FIVE',json.dumps(newread))
        self.cli('owner','topic-remove-member','--topic',topic,'--member',partner)
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-AFTER-REMOVAL')
        self.cli('partner','read','--topic',topic,expected=1)
        snapshot=json.loads(self.exchange({'snapshot':True})['body'])
        self.assertNotIn('PRIVATE-',json.dumps(snapshot))
        self.assertTrue(all(t['e2ee']==1 and t['current_epoch']>0 for t in snapshot['topics']))
        self.assertTrue((Path(hub.profile_dir('owner'))/'recovery-phrase.txt').exists())

    def test_lost_create_and_commit_responses_resume_without_duplicates(self):
        owner = self.setup_owner()
        original = self.transport
        losses = {"/v2/topics":1, "commit":1}
        def unreliable(method, url, headers, body):
            code, text = original(method, url, headers, body)
            path = urlparse(url).path
            key = "commit" if path.endswith("/keys/commit") else path
            if method == "POST" and code in (200,201) and losses.get(key):
                losses[key] -= 1
                return 503, json.dumps({"error":{"code":"unavailable","message":"lost response"}})
            return code, text
        self.transport = unreliable
        with mock.patch.object(hub.time, "sleep"):
            self.cli('owner','new-topic','--subject','PRIVATE-RETRY','--with',owner,expected=1)
            topic = self.cli('owner','new-topic','--subject','PRIVATE-RETRY','--with',owner)['topic']['id']
        snapshot = json.loads(self.exchange({'snapshot':True})['body'])
        self.assertEqual(len(snapshot['topics']),1)
        self.assertEqual(snapshot['topics'][0]['current_epoch'],1)
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-RETRY-SUCCESS')
        self.assertIn('PRIVATE-RETRY-SUCCESS',json.dumps(self.cli('owner','read','--topic',topic)))
        self.assertEqual(list((Path(hub.profile_dir('owner'))/'pending-topics').glob('*')),[])

    def test_changed_identity_requires_verified_approval(self):
        owner = self.setup_owner(); partner = self.join('partner')
        self.cli('owner','new-topic','--subject','PRIVATE-FIRST','--with',owner+','+partner)
        token = hub.load_token(hub.load_config('partner'),'partner')[0]
        private = PrivateKey.generate()
        public = bytes(private.public_key)
        code,_ = self.api('POST','/v2/agent-keys/rotate',{'agent_public_key':base64.b64encode(public).decode()},token)
        self.assertEqual(code,200)
        hub._write_secret_file_0600(hub.agent_key_path('partner'),bytes(private),'test replacement identity')
        self.cli('owner','new-topic','--subject','PRIVATE-SECOND','--with',owner+','+partner,expected=1)
        self.cli('owner','key-trust','--member',partner,'--agent','partner-agent','--fingerprint','00'*32,'--yes',expected=1)
        self.cli('owner','key-trust','--member',partner,'--agent','partner-agent','--fingerprint',hashlib.sha256(public).hexdigest(),'--yes')
        topic = self.cli('owner','new-topic','--subject','PRIVATE-SECOND','--with',owner+','+partner)['topic']['id']
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-AFTER-VERIFICATION')
        self.assertIn('PRIVATE-AFTER-VERIFICATION',json.dumps(self.cli('partner','read','--topic',topic)))

    def test_full_history_grants_all_epochs_and_subject_discovery(self):
        owner = self.setup_owner()
        topic = self.cli('owner','new-topic','--subject','PRIVATE-SHARED-PLAN','--with',owner)['topic']['id']
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-OLD-EPOCH')
        self.cli('owner','topic-rekey','--topic',topic)
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-RECENT-EPOCH')
        member = self.join('newcomer')
        self.cli('owner','invite','--topic',topic,'--member',member,'--history','full')
        self.cli('owner','topic-add-member','--topic',topic,'--member',member)
        topics = self.cli('newcomer','topics','--search','shared plan')
        # Search is local, using the decrypted title.
        self.assertEqual(topics,[])  # punctuation is literal, not a fuzzy match
        topics = self.cli('newcomer','topics','--search','SHARED-PLAN')
        self.assertEqual(topics[0]['subject'],'PRIVATE-SHARED-PLAN')
        sync = self.cli('newcomer','sync')
        self.assertEqual(sync[0]['subject'],'PRIVATE-SHARED-PLAN')
        history = json.dumps(self.cli('newcomer','read','--topic',topic))
        self.assertIn('PRIVATE-OLD-EPOCH',history)
        self.assertIn('PRIVATE-RECENT-EPOCH',history)

    def test_crypto_failure_never_consumes_enrollment_code(self):
        code, created = self.api('POST','/v2/families',{'name':'Fresh','owner_name':'Owner','owner_email':'owner@example.test'})
        self.assertEqual(code,201)
        with mock.patch.object(hub,'_require_nacl',side_effect=hub.HubError('config','crypto unavailable')):
            self.cli('owner','setup','--server','https://hub.test','--invite',created['provisioning_code'],'--store','file',expected=1)
        # The same one-use code still works after local prerequisites are fixed.
        self.cli('owner','setup','--server','https://hub.test','--invite',created['provisioning_code'],'--store','file')
        self.assertTrue(self.cli('owner','me')['member']['id'])

    def test_tamper_and_missing_local_keys_never_send_plaintext(self):
        owner = self.setup_owner()
        topic = self.cli('owner','new-topic','--subject','PRIVATE-CONTENT','--with',owner)['topic']['id']
        keys = hub._load_topic_keys('owner',topic)
        key_id, old_key = next(iter(keys.items()))
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-ORIGINAL')
        original = self.transport
        def tampered(method,url,headers,body):
            code,text = original(method,url,headers,body)
            if method=='GET' and urlparse(url).path.endswith('/history'):
                response = json.loads(text)
                entry = next(e for e in response['entries'] if e['kind']=='message')
                parts = entry['body'].split('.')
                raw = bytearray(base64.b64decode(parts[3])); raw[-1] ^= 1
                parts[3] = base64.b64encode(raw).decode(); entry['body']='.'.join(parts)
                text=json.dumps(response)
            return code,text
        self.transport=tampered
        self.cli('owner','read','--topic',topic,expected=1)
        self.transport=original
        Path(hub._topic_key_file('owner',topic)).unlink()
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-MUST-NOT-LEAK',expected=1)
        snapshot=json.loads(self.exchange({'snapshot':True})['body'])
        self.assertEqual(len([e for e in snapshot['entries'] if e['kind']=='message']),1)
        self.assertNotIn('PRIVATE-',json.dumps(snapshot))
        hub._merge_topic_key('owner',topic,key_id,old_key)
        self.cli('owner','topic-rekey','--topic',topic)
        self.cli('owner','post','--topic',topic,'--message','PRIVATE-AFTER-ROTATION')
        snapshot=json.loads(self.exchange({'snapshot':True})['body'])
        wire=next(e['body'] for e in reversed(snapshot['entries']) if e['kind']=='message')
        kid,mid,nonce,cipher=hub._e2ee_parse_wire(wire)
        with self.assertRaises(Exception):
            bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(cipher,hub._e2ee_msg_aad(topic,kid,mid),nonce,old_key)

if __name__=='__main__': unittest.main()
