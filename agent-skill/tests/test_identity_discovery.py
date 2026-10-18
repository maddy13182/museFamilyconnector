"""Discovery protocol, routing isolation, and enrollment proof persistence."""
import json
import os
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse, parse_qs
from test_hub import HubTestBase, hub


class IdentityDiscoveryTest(HubTestBase):
    def profile(self, name, server, token):
        self.seed_config(profile=name,server_url=server,user={"id":"user-1"})
        hub._write_secret_file_0600(hub.default_token_path(name),(token+"\n").encode(),"test credential")

    def envelope(self, server, kind, rows, cursor=None):
        return {"protocol_version":1,"server":{"url":server},"data":{kind:rows},
                "page":{"limit":100,"next_cursor":cursor},"request_id":"test-request"}

    def test_all_servers_keep_credentials_and_duplicate_names_separate(self):
        self.profile('family','https://family.test','fh_family_private')
        self.profile('hotel','https://hotel.test','fh_hotel_private')
        requests=[]
        def route(method,url,headers,body):
            parsed=urlparse(url);server='https://'+parsed.netloc
            if parsed.path=='/v2/health':
                self.assertNotIn('Authorization',headers)
                return 200,json.dumps({'discovery_protocol':1})
            expected='fh_family_private' if parsed.netloc=='family.test' else 'fh_hotel_private'
            self.assertEqual(headers['Authorization'],'Bearer '+expected)
            requests.append((server,headers['Authorization']))
            row={'user_id':'same-local-id','name':'Lakshmi','email':'person@example.test',
                 'memberships':[{'circle_id':'local-circle','member_id':'local-member','role':'parent'}]}
            return 200,json.dumps(self.envelope(server,'people',[row]))
        with mock.patch.object(hub,'_startup_integrity_check',return_value=True):
            from test_hub import captured
            with captured() as (out,err):
                rc=hub.main(['people','--query','Lakshmi','--all-servers'],transport=route)
        self.assertEqual(rc,0,err.getvalue())
        result=json.loads(out.getvalue())
        self.assertTrue(result['complete'])
        people=result['data']['people']
        self.assertEqual(len(people),2)
        self.assertEqual({p['server_url'] for p in people},{'https://family.test','https://hotel.test'})
        self.assertEqual({p['profile'] for p in people},{'family','hotel'})
        for token in ['fh_family_private','fh_hotel_private']:
            self.assertNotIn(token,out.getvalue()+err.getvalue())
        self.assertEqual(len(requests),2)

    def test_one_server_failure_preserves_results_and_returns_nonzero(self):
        self.profile('family','https://family.test','fh_family_private')
        self.profile('hotel','https://hotel.test','fh_hotel_private')
        def route(method,url,headers,body):
            if 'hotel.test' in url:
                return 401,json.dumps({'error':{'code':'unauthorized','message':'private token details'}})
            if url.endswith('/health'):return 200,json.dumps({'discovery_protocol':1})
            return 200,json.dumps(self.envelope('https://family.test','circles',[{'circle_id':'family'}]))
        from test_hub import captured
        with mock.patch.object(hub,'_startup_integrity_check',return_value=True),captured() as (out,err):
            rc=hub.main(['circles','--all-servers'],transport=route)
        result=json.loads(out.getvalue())
        self.assertEqual(rc,1);self.assertFalse(result['complete'])
        self.assertEqual(len(result['data']['circles']),1)
        self.assertEqual(result['errors'][0]['profile'],'hotel')
        self.assertNotIn('private token details',out.getvalue())

    def test_unscoped_environment_token_is_never_broadcast(self):
        self.seed_config(profile='family',server_url='https://family.test')
        calls=[]
        def route(*args):
            calls.append(args);self.fail('No stored profile credential; must fail locally')
        from test_hub import captured
        with mock.patch.object(hub,'_startup_integrity_check',return_value=True),captured() as (out,err):
            rc=hub.main(['circles','--all-servers'],transport=route)
        self.assertEqual(rc,1);self.assertFalse(calls)
        self.assertEqual(json.loads(out.getvalue())['errors'][0]['profile'],'family')

    def test_pagination_and_repeated_cursor_detection(self):
        pages=[]
        def route(method,url,headers,body):
            cursor=parse_qs(urlparse(url).query).get('cursor',[''])[0];pages.append(cursor)
            row={'circle_id':'one' if not cursor else 'two'}
            return 200,json.dumps(self.envelope('https://family.test','circles',[row],None if cursor else 'one'))
        client=hub.HubClient('https://family.test','private',transport=route)
        rows=hub._discovery_pages(client,'circles')
        self.assertEqual([r['circle_id'] for r in rows],['one','two']);self.assertEqual(pages,['','one'])
        def looping(*args):return 200,json.dumps(self.envelope('https://family.test','circles',[{'circle_id':'one'}],'one'))
        with self.assertRaises(hub.HubError):hub._discovery_pages(hub.HubClient('https://family.test','private',transport=looping),'circles')

    def test_wrong_origin_envelope_is_rejected(self):
        def route(*args):return 200,json.dumps(self.envelope('https://other.test','people',[]))
        with self.assertRaises(hub.HubError):
            hub._discovery_pages(hub.HubClient('https://family.test','private',transport=route),'people')

    def test_diagnostics_cannot_overwrite_profile_material(self):
        self.seed_config();path=Path(hub.config_path('default'));before=path.read_bytes()
        rc,out,err=self.run_cli(['diagnostics','export','--output',str(path)])
        self.assertEqual(rc,1);self.assertEqual(path.read_bytes(),before)
        self.assertIn('outside the connector configuration directory',err)

    def test_explicit_circle_is_request_local_and_preserves_saved_selection(self):
        self.seed_config(active_circle_id='family')
        self.fake.add('GET','/v2/families',200,{'families':[
            {'id':'family','name':'Family','member_id':'member-family','my_role':'parent'},
            {'id':'hotel','name':'Hotel','member_id':'member-hotel','my_role':'parent'}]})
        self.fake.add('GET','/v2/topics',200,{'topics':[]})
        rc,out,err=self.run_cli(['topics','--circle','Hotel'])
        self.assertEqual(rc,0,err)
        self.assertEqual(self.fake.calls[-1]['headers']['X-Circle-ID'],'hotel')
        cfg=hub.load_config('default')
        self.assertEqual(cfg['active_circle_id'],'family')
        self.assertNotIn('_request_circle_id',cfg)
        self.assertNotIn('hotel',cfg.get('circle_members',{}))

    def test_malformed_server_metadata_is_a_structured_profile_error(self):
        self.profile('family','https://family.test','fh_family_private')
        def route(method,url,headers,body):
            if url.endswith('/health'):return 200,json.dumps({'discovery_protocol':1})
            return 200,json.dumps({'protocol_version':1,'server':[],'data':{},'page':{}})
        from test_hub import captured
        with mock.patch.object(hub,'_startup_integrity_check',return_value=True),captured() as (out,err):
            rc=hub.main(['circles','--all-servers'],transport=route)
        self.assertEqual(rc,1)
        self.assertEqual(json.loads(out.getvalue())['errors'][0]['code'],'protocol')

    def test_recovery_cannot_overwrite_another_users_profile(self):
        self.seed_config(user={'id':'first-user','email':'first@example.test'})
        path=Path(hub.config_path('default'));before=path.read_bytes()
        rc,out,err=self.run_cli(['enroll','--recover-email','second@example.test','--label','replacement'])
        self.assertEqual(rc,1);self.assertIn('separate profile',err)
        self.assertEqual(path.read_bytes(),before)
        self.assertFalse(any(c['method']=='POST' for c in self.fake.calls))

    def test_join_without_saved_credential_never_redeems_invite(self):
        self.seed_config(user={'id':'first-user','email':'first@example.test'})
        os.environ.pop('FAMILY_HUB_TOKEN',None)
        rc,out,err=self.run_cli(['circle','join','--code','fhi_private_invite','--name','Person','--label','phone'])
        self.assertEqual(rc,1)
        self.assertFalse(any(c['method']=='POST' for c in self.fake.calls))
        self.assertFalse(Path(hub._pending_enrollment('default')).exists())

    def test_email_proof_error_explains_enrollment_instead_of_topic_permissions(self):
        error=hub.HubError('forbidden','Proof required',server_code='email_verification_required')
        message=error.friendly()
        self.assertIn('--verification-code-file',message)
        self.assertNotIn('topics you participate',message)

    def test_agent_approval_is_private_and_never_overwrites_existing_files(self):
        self.seed_config()
        target=Path(self.tmp)/'approval.txt'
        self.fake.add('GET','/v2/me',200,{'id':'own-member'})
        self.fake.add('POST','/v2/provisioning-codes',201,{'provisioning_code':'fhp_PRIVATEapproval','expires_at':'2030-01-01T00:00:00Z'})
        rc,out,err=self.run_cli(['agent-invite','--label','phone','--output',str(target)])
        self.assertEqual(rc,0,err)
        self.assertEqual(target.read_text(),'fhp_PRIVATEapproval\n')
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        self.assertNotIn('fhp_PRIVATEapproval',out+err)
        before=len(self.fake.calls)
        rc,out,err=self.run_cli(['agent-invite','--label','phone','--output',str(target)])
        self.assertEqual(rc,1)
        self.assertFalse(any(c['method']=='POST' for c in self.fake.calls[before:]))
        self.assertEqual(target.read_text(),'fhp_PRIVATEapproval\n')

    def test_failed_approval_removes_only_the_new_empty_file(self):
        self.seed_config()
        target=Path(self.tmp)/'approval.txt'
        self.fake.add('GET','/v2/me',200,{'id':'own-member'})
        self.fake.add('POST','/v2/provisioning-codes',403,{'error':{'code':'forbidden','message':'Denied'}})
        rc,out,err=self.run_cli(['agent-invite','--label','phone','--output',str(target)])
        self.assertEqual(rc,1);self.assertFalse(target.exists())
        self.assertEqual(len([c for c in self.fake.calls if c['method']=='POST']),1)
