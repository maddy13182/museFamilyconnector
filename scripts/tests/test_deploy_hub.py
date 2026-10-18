"""Provisioning journeys with a fake Cloudflare account; no live writes."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('deploy_hub', Path(__file__).resolve().parents[1] / 'deploy_hub.py')
hub = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hub)


class Cloud:
    def __init__(self, account='a' * 32):
        self.account = account
        self.dbs = {}
        self.workers = {}
        self.created_secrets = []
        self.created_databases = 0
        self.fail_db_reply = False
        self.fail_worker_reply = False
        self.subdomain = None

    def settings(self, name):
        return copy.deepcopy(self.workers.get(name))

    def databases(self, name):
        return [dict(row) for row in self.dbs.values() if row['name'] == name]

    def call(self, method, path, body=None, missing_ok=False):
        if path == '/d1/database' and method == 'POST':
            self.created_databases += 1
            row = {'name': body['name'], 'uuid': self.account[:8] + '-db-' + str(self.created_databases)}
            self.dbs[row['uuid']] = row
            if self.fail_db_reply:
                self.fail_db_reply = False
                raise hub.DeployError('lost database creation reply')
            return dict(row)
        if path.startswith('/d1/database/'):
            if path.rsplit('/', 1)[1] not in self.dbs:
                raise hub.DeployError('database missing')
            return self.dbs[path.rsplit('/', 1)[1]]
        if path == '/workers/subdomain':
            if method == 'PUT':
                self.subdomain = body['subdomain']
            return {'subdomain': self.subdomain} if self.subdomain else None
        raise AssertionError((method, path))



class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'deployment'
        self.api = Cloud()
        self.commands = []
        self.configs = []

    def runner(self, args):
        self.commands.append(args)
        config = json.loads(Path(args[args.index('--config') + 1]).read_text())
        self.configs.append(config)
        if args[0] == 'deploy':
            # Wrangler preserves secret bindings while updating configured vars/DB.
            if '--secrets-file' in args:
                values = json.loads(Path(args[args.index('--secrets-file') + 1]).read_text())
                self.api.created_secrets.append(values)
                found = [{'type': 'secret_text', 'name': key} for key in values]
            else:
                found = [b for b in self.api.workers[config['name']]['bindings'] if b['type'] == 'secret_text']
            found += [{'type': 'd1', 'name': 'DB', 'id': config['d1_databases'][0]['database_id']}]
            found += [{'type': 'plain_text', 'name': k, 'text': v} for k, v in config['vars'].items()]
            self.api.workers[config['name']] = {'bindings': found}
            if self.api.fail_worker_reply:
                self.api.fail_worker_reply = False
                raise hub.DeployError('lost Worker upload reply')

    def response(self, url, payload=None, secret=None):
        if url.endswith('/v2/health'):
            return {'ok': True, 'api_versions': ['v2'], 'encryption_required': True, 'enrollment_resume': True, 'identity_protocol': 1, 'discovery_protocol': 1}
        if url.endswith('/v2/client/latest'):
            origin = url.removesuffix('/v2/client/latest')
            return {'version': '2.2.0', 'sha256': 'a' * 64,
                    'download_url': origin + '/v2/client/download/hub',
                    'skill': {'version': '2.2.0', 'sha256': 'b' * 64,
                              'url': origin + '/v2/client/download/skill.tar.gz'}}
        self.assertTrue(secret)
        return {'provisioning_code': 'fhp_private_receipt', 'member': {'family_id': 'circle'}}

    def run_provision(self, **kwargs):
        defaults = {'runner': self.runner, 'hub_request': self.response, 'report': lambda msg: None}
        defaults.update(kwargs)
        return hub.provision(self.api.account, 'my-hub', self.api, self.directory, **defaults)

    def test_two_accounts_same_name_get_their_own_bindings_and_secrets(self):
        first = self.run_provision()
        first_secrets = json.loads((self.directory / 'secrets.json').read_text())
        self.assertEqual(self.configs[0]['account_id'], 'a' * 32)
        self.assertEqual(self.configs[0]['vars']['SETUP_LOCKED'], '1')
        self.assertEqual(self.configs[0]['d1_databases'][0]['database_id'], first['database_id'])
        self.api = Cloud('b' * 32)
        self.directory = Path(self.temp.name) / 'other'
        second = self.run_provision()
        self.assertNotEqual(first['database_id'], second['database_id'])
        self.assertNotEqual(first['url'], second['url'])
        self.assertNotEqual(first_secrets, self.api.created_secrets[0])
        for file in self.directory.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.api.created_secrets[0]), 3)

    def test_retry_after_lost_database_create_reply_reuses_database(self):
        self.api.fail_db_reply = True
        with self.assertRaises(hub.DeployError):
            self.run_provision()
        state = self.run_provision()
        self.assertEqual(self.api.created_databases, 1)
        self.assertEqual(len(self.api.dbs), 1)
        self.assertEqual(state['database_id'], next(iter(self.api.dbs)))

    def test_retry_after_lost_worker_upload_reply_does_not_rotate_secrets(self):
        self.api.fail_worker_reply = True
        with self.assertRaises(hub.DeployError):
            self.run_provision()
        saved = (self.directory / 'secrets.json').read_text()
        self.run_provision()
        self.assertEqual(len(self.api.created_secrets), 1)
        self.assertEqual((self.directory / 'secrets.json').read_text(), saved)

    def test_migration_failure_stops_before_real_api_deploy_and_can_resume(self):
        def fail(args):
            raise hub.DeployError('migration failure')
        with self.assertRaises(hub.DeployError):
            self.run_provision(runner=fail)
        self.assertEqual(self.commands, [])
        self.run_provision()
        self.assertEqual(self.api.created_databases, 1)
        self.assertEqual(len(self.api.created_secrets), 1)
        self.assertEqual(self.commands[0][:4], ['d1', 'migrations', 'apply', 'DB'])

    def test_existing_unowned_worker_is_not_overwritten(self):
        self.api.workers['my-hub'] = {'bindings': []}
        with self.assertRaises(hub.DeployError):
            self.run_provision()
        self.assertFalse((self.directory / 'state.json').exists())
        self.assertEqual(self.api.created_databases, 0)

    def test_changed_remote_binding_blocks_update(self):
        self.run_provision()
        for binding in self.api.workers['my-hub']['bindings']:
            if binding['name'] == 'DB':
                binding['id'] = 'somebody-elses-database'
        before = len(self.commands)
        with self.assertRaises(hub.DeployError):
            self.run_provision()
        self.assertEqual(len(self.commands), before)

    def test_explicit_existing_update_discovers_binding_without_creating_or_rotating(self):
        original = self.run_provision()
        self.directory = Path(self.temp.name) / 'clean-checkout'
        updated = self.run_provision(existing=True)
        self.assertEqual(original['database_id'], updated['database_id'])
        self.assertEqual(self.api.created_databases, 1)
        self.assertEqual(len(self.api.created_secrets), 1)
        self.assertFalse((self.directory / 'secrets.json').exists())

    def test_existing_missing_worker_cannot_create_replacement(self):
        with self.assertRaises(hub.DeployError):
            self.run_provision(existing=True)
        self.assertEqual(self.api.created_databases, 0)

    def test_bootstrap_keeps_code_private_and_relocks_on_success(self):
        state = self.run_provision(bootstrap={'name': 'Family', 'owner_name': 'Owner', 'owner_email': 'owner@example.test'})
        receipt = self.directory / 'owner-enrollment.json'
        self.assertEqual(json.loads(receipt.read_text())['provisioning_code'], 'fhp_private_receipt')
        self.assertEqual([c['vars']['SETUP_LOCKED'] for c in self.configs if c['name'] == 'my-hub'], ['1', '1', '0', '1'])
        self.assertEqual(json.loads((self.directory / 'wrangler.json').read_text())['vars']['SETUP_LOCKED'], '1')
        self.assertTrue(state['verified'])

    def test_lost_bootstrap_response_relocks_and_does_not_repeat_on_retry(self):
        def response(url, payload=None, secret=None):
            if payload:
                raise hub.DeployError('response lost')
            return self.response(url)
        details = {'name': 'Family', 'owner_name': 'Owner', 'owner_email': 'owner@example.test'}
        with self.assertRaises(hub.DeployError):
            self.run_provision(bootstrap=details, hub_request=response)
        self.assertEqual(self.configs[-1]['vars']['SETUP_LOCKED'], '1')
        with self.assertRaisesRegex(hub.DeployError, 'earlier bootstrap'):
            self.run_provision(bootstrap=details)
        self.assertFalse((self.directory / 'owner-enrollment.json').exists())

    def test_build_failure_precedes_all_remote_resource_creation(self):
        def build():
            raise hub.DeployError('unverified client artifacts')
        with self.assertRaises(hub.DeployError):
            self.run_provision(build=build)
        self.assertFalse(self.api.dbs)
        self.assertFalse(self.api.workers)

    def test_missing_previously_created_worker_does_not_recreate(self):
        self.run_provision()
        del self.api.workers['my-hub']
        with self.assertRaisesRegex(hub.DeployError, 'Refusing to create'):
            self.run_provision()
        self.assertEqual(len(self.api.created_secrets), 1)

    def test_remote_runtime_settings_survive_upgrade(self):
        self.run_provision()
        self.api.workers['my-hub']['bindings'].append(
            {'type': 'plain_text', 'name': 'OPERATOR_SETTING', 'text': 'keep-me'})
        for binding in self.api.workers['my-hub']['bindings']:
            if binding['name'] == 'MIN_CLI_VERSION':
                binding['text'] = '2.2.0'
        self.run_provision()
        self.assertEqual(self.configs[-1]['vars']['OPERATOR_SETTING'], 'keep-me')
        self.assertEqual(self.configs[-1]['vars']['MIN_CLI_VERSION'], '2.2.0')

    def test_invalid_manifest_stops_before_bootstrap(self):
        def response(url, payload=None, secret=None):
            if url.endswith('/v2/client/latest'):
                return {'version': '2.2.0', 'sha256': 'wrong'}
            return self.response(url, payload, secret)
        with self.assertRaisesRegex(hub.DeployError, 'manifest'):
            self.run_provision(bootstrap={'name': 'Family'}, hub_request=response)
        self.assertEqual(self.configs[-1]['vars']['SETUP_LOCKED'], '1')
        self.assertFalse((self.directory / 'owner-enrollment.json').exists())

    def test_shared_template_has_no_account_or_database_identity(self):
        template = hub.tomllib.loads((hub.SERVER / 'wrangler.toml').read_text())
        self.assertNotIn('account_id', template)
        for db in template['d1_databases']:
            self.assertNotIn('database_id', db)

    def test_missing_bootstrap_guard_cannot_open_setup_window(self):
        self.run_provision()
        self.api.workers['my-hub']['bindings'] = [
            b for b in self.api.workers['my-hub']['bindings'] if b['name'] != 'BOOTSTRAP_SECRET']
        before = len(self.commands)
        with self.assertRaisesRegex(hub.DeployError, 'missing required secrets'):
            self.run_provision(bootstrap={'name': 'Family'})
        self.assertEqual(len(self.commands), before)

    def test_secrets_stored_as_plain_vars_are_not_adopted(self):
        self.run_provision()
        for binding in self.api.workers['my-hub']['bindings']:
            if binding['name'] == 'TOKEN_PEPPER':
                binding['type'] = 'plain_text'
                binding['text'] = 'must-not-copy'
        self.directory = Path(self.temp.name) / 'another-checkout'
        with self.assertRaises(hub.DeployError):
            self.run_provision(existing=True)
        self.assertFalse((self.directory / 'state.json').exists())

    def test_interrupted_explicit_adoption_can_resume_without_losing_identity(self):
        self.run_provision()
        # Emulate an installation made before deployment markers existed.
        self.api.workers['my-hub']['bindings'] = [
            b for b in self.api.workers['my-hub']['bindings'] if b['name'] != 'HUB_DEPLOYMENT_ID']
        self.directory = Path(self.temp.name) / 'fresh-adoption'
        def fail(args):
            raise hub.DeployError('migration interrupted')
        with self.assertRaises(hub.DeployError):
            self.run_provision(existing=True, runner=fail)
        self.run_provision(existing=True)
        self.assertEqual(self.api.created_databases, 1)
        self.assertEqual(len(self.api.created_secrets), 1)
