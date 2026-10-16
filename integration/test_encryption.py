"""Production CLI + Worker integration. Run after `npm test` in server/."""
import contextlib
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
        if token: headers['Authorization']='Bearer '+token
        code,text=self.transport(method,'https://hub.test'+path,headers,json.dumps(body).encode() if body is not None else None)
        return code,json.loads(text)
    def cli(self,profile,*args,expected=0):
        out,err=io.StringIO(),io.StringIO()
        with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
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
