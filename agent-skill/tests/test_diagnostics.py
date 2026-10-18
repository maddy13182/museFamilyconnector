"""Failure evidence must survive without --debug and never contain credentials."""
import http.client
import importlib.util
import json
import os
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock

path = str(Path(__file__).resolve().parents[1] / 'hub')
spec = importlib.util.spec_from_file_location('hub_diagnostics', path,
    loader=SourceFileLoader('hub_diagnostics', path))
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class DiagnosticsTest(unittest.TestCase):
    def test_lost_response_then_used_code_is_recorded_without_debug(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'FAMILY_HUB_CONFIG_HOME': tmp}), mock.patch.object(hub.time, 'sleep'):
            calls = []
            def transport(method, url, headers, body):
                calls.append(dict(headers))
                if len(calls) == 1:
                    raise http.client.RemoteDisconnected('sensitive transport detail')
                return 409, json.dumps({'error': {'code': 'invite_used', 'message': 'Invite already used'}})
            client = hub.HubClient('https://hub.test', transport=transport)
            with self.assertRaises(hub.HubError):
                client.call('POST', '/v2/invites/fhi_secret/accept', auth=False,
                    json_body={'display_name': 'Private name', 'agent_public_key': 'private-body-value', 'agent_token': 'fh_' + 'x' * 43})
            log = Path(hub.profile_dir('default')) / 'diagnostics.jsonl'
            raw = log.read_text()
            rows = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual([r['event'] for r in rows], [
                'http_attempt_started', 'http_transport_failed', 'http_retry_scheduled',
                'http_attempt_started', 'http_response_received'])
            self.assertEqual(rows[-1]['status'], 409)
            self.assertEqual(calls[0]['X-Operation-ID'], calls[1]['X-Operation-ID'])
            self.assertNotEqual(calls[0]['X-Request-ID'], calls[1]['X-Request-ID'])
            self.assertEqual(rows[0]['request_id'], calls[0]['X-Request-ID'])
            for secret in ['fhi_secret', 'Private name', 'private-body-value', 'sensitive transport detail']:
                self.assertNotIn(secret, raw)
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def test_invalid_json_has_distinct_evidence(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'FAMILY_HUB_CONFIG_HOME': tmp}):
            client = hub.HubClient('https://hub.test', transport=lambda *a: (201, 'not json'))
            with self.assertRaises(hub.HubError):
                client.call('GET', '/v2/health', auth=False)
            rows = [json.loads(line) for line in (Path(hub.profile_dir('default')) / 'diagnostics.jsonl').read_text().splitlines()]
            self.assertEqual(rows[-1]['event'], 'http_json_invalid')
            self.assertEqual(rows[-2]['status'], 201)

    def test_save_failure_records_actual_nonzero_exit_and_last_milestone(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'FAMILY_HUB_CONFIG_HOME': tmp}), mock.patch.object(hub, '_startup_integrity_check', return_value=True), mock.patch.object(hub, '_require_server_version'), mock.patch.object(hub, '_ensure_identity_keypair', return_value=(b'key', 'public', False)), mock.patch.object(hub, '_write_secret_file_0600', side_effect=OSError('storage failed')):
            def transport(*args):
                return 201, json.dumps({'token': json.loads(args[3])['agent_token'], 'token_id': 'id',
                    'member': {'id': 'member', 'family_id': 'circle'}})
            result = hub.main(['setup', '--server', 'https://hub.test', '--invite',
                'fhi_private_code', '--name', 'Private name', '--email','person@example.test','--label', 'agent'], transport)
            self.assertNotEqual(result, 0)
            raw = (Path(hub.profile_dir('default')) / 'diagnostics.jsonl').read_text()
            rows = [json.loads(line) for line in raw.splitlines()]
            self.assertIn('credential_save_started', [r['event'] for r in rows])
            self.assertNotIn('credential_file_saved', [r['event'] for r in rows])
            self.assertEqual(rows[-1]['event'], 'command_finished')
            self.assertEqual(rows[-1]['exit_code'], result)
            self.assertEqual(len({r['run_id'] for r in rows}), 1)
            self.assertNotIn('fh_private_token', raw)
            self.assertNotIn('fhi_private_code', raw)

    def test_export_is_offline_and_excludes_configuration_keys_and_unknown_fields(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'FAMILY_HUB_CONFIG_HOME': tmp}):
            directory = Path(hub.profile_dir('default'))
            directory.mkdir(parents=True)
            (directory / 'config.json').write_text('{"token":"PRIVATE-CONFIG"}')
            (directory / 'agent.key').write_text('PRIVATE-IDENTITY')
            (directory / 'pending-enrollment.json').write_text('PRIVATE-PENDING')
            (directory / 'diagnostics.jsonl').write_text(json.dumps({
                'event':'http_response_received','run_id':'previous','status':409,
                'request_id':'a'*32,'token':'PRIVATE-UNKNOWN-FIELD',
                'path':'/v2/invites/fhi_private-code/accept'})+'\n')
            output = Path(tmp) / 'report.json'
            def offline(*args):
                self.fail('Diagnostics export must not contact the server')
            with mock.patch.object(hub, 'load_config', side_effect=AssertionError('must not read config')):
                self.assertEqual(hub.main(['diagnostics','export','--output',str(output)],offline),0)
            raw = output.read_text()
            for secret in ['PRIVATE-CONFIG','PRIVATE-IDENTITY','PRIVATE-PENDING','PRIVATE-UNKNOWN-FIELD','fhi_private-code']:
                self.assertNotIn(secret,raw)
            self.assertTrue(json.loads(raw)['pending_enrollment'])
            self.assertEqual(output.stat().st_mode & 0o777,0o600)
