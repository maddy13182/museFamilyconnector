#!/usr/bin/env python3
"""Per-account Cloudflare provisioning. Credentials are environment-only.

Uses Cloudflare's JSON API for resource discovery/creation and pinned local
Wrangler for migrations and code deployment. No remote resources are deleted.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import tomllib
from urllib import error, request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / 'server'
SECRET_NAMES = ('TOKEN_PEPPER', 'READ_RECEIPT_SECRET', 'BOOTSTRAP_SECRET')


class DeployError(Exception):
    pass


class NoRedirect(request.HTTPRedirectHandler):
    # Never forward Cloudflare authorization or bootstrap capabilities elsewhere.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = request.build_opener(NoRedirect())


def private_json(path, value):
    """Atomic replacement; secrets and receipts never go through stdout."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def deployment_lock(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'deploy.lock').open('a+b') as stream:
        os.chmod(stream.name, 0o600)
        try:
            import fcntl
        except ImportError:
            raise DeployError('Run provisioning on Linux, macOS, or Windows WSL.') from None
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError('Another deployment is running for this hub.') from None
        yield


class Cloudflare:
    def __init__(self, account, token):
        self.base = f'https://api.cloudflare.com/client/v4/accounts/{account}'
        self.token = token

    def call(self, method, path, body=None, missing_ok=False):
        headers = {'Authorization': 'Bearer ' + self.token,
                   'User-Agent': 'family-hub-provisioner'}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        req = request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with HTTP.open(req, timeout=60) as response:  # nosec B310 -- fixed HTTPS Cloudflare origin
                result = json.load(response)
        except error.HTTPError as exc:
            if missing_ok and exc.code == 404:
                return None
            raise DeployError(f'Cloudflare {method} {path}: HTTP {exc.code}. Check account and token permissions.') from None
        except (error.URLError, TimeoutError, ValueError):
            raise DeployError(f'Cloudflare {method} {path} did not return a usable response. Re-run the same command to inspect/resume.') from None
        if not result.get('success'):
            raise DeployError(f'Cloudflare {method} {path} rejected the operation; no response body was logged.')
        return result.get('result')

    def databases(self, name):
        # Name filtering is exact-checked locally; paginate to avoid adopting a
        # similarly named database or missing one on a large account.
        from urllib.parse import urlencode
        page = 1
        while True:
            rows = self.call('GET', '/d1/database?' + urlencode({'name': name, 'page': page, 'per_page': 100}))
            for row in rows:
                if row['name'] == name:
                    yield row
            if len(rows) < 100:
                break
            page += 1

    def settings(self, name):
        return self.call('GET', f'/workers/scripts/{name}/settings', missing_ok=True)


def bindings(settings):
    if not isinstance(settings, dict):
        raise DeployError('Worker settings are not available yet. Re-run the same command to reconcile deployment.')
    return {item['name']: item for item in settings.get('bindings', [])}


def check_worker(settings, state):
    found = bindings(settings)
    marker = found.get('HUB_DEPLOYMENT_ID', {}).get('text')
    db = found.get('DB', {}).get('id')
    marker_ok = marker == state['deployment_id'] or (state.get('adoption_pending') and marker == state.get('previous_marker'))
    if not marker_ok or db != state['database_id']:
        raise DeployError('Worker ownership or DB binding differs from local state. Refusing to overwrite it.')
    required = SECRET_NAMES[:2] if state.get('existing') else SECRET_NAMES
    if not all(found.get(name, {}).get('type') == 'secret_text' for name in required):
        raise DeployError('Existing Worker is missing required secrets. Restore them; deployment never rotates them automatically.')


def generate_config(state, template, unlocked=False):
    config = dict(template)
    config.update(name=state['worker_name'], account_id=state['account_id'], workers_dev=True,
                  main=str(SERVER / template['main']))
    config['d1_databases'] = [{'binding': 'DB', 'database_name': state['database_name'],
        'database_id': state['database_id'], 'migrations_dir': str(SERVER / 'migrations')}]
    config['vars'] = {**template.get('vars', {}), **state.get('extra_vars', {}),
                      'HUB_DEPLOYMENT_ID': state['deployment_id'], 'SETUP_LOCKED': '0' if unlocked else '1'}
    return config


def run_command(arguments):
    # Secret values stay in private files; Wrangler receives a file path only.
    result = subprocess.run(arguments, cwd=SERVER, env={**os.environ, 'CI': 'true',
        'WRANGLER_SEND_METRICS': 'false', 'WRANGLER_LOG_SANITIZE': 'true'}, capture_output=True, text=True)  # nosec B603 -- fixed executables, no shell
    if result.returncode:
        # Wrangler may echo remote errors; never relay untrusted output that
        # could contain auth headers or secret values.
        raise DeployError(f'{Path(arguments[0]).name} command failed (exit {result.returncode}); stage not completed.')


def wrangler(arguments):
    executable = SERVER / 'node_modules/wrangler/bin/wrangler.js'
    if not executable.exists():
        raise DeployError('Wrangler is not installed. Run npm ci in server/ first.')
    run_command(['node', str(executable), *arguments])


def get_json(url, payload=None, secret=None):
    headers = {'User-Agent': 'family-hub-provisioner', 'Accept': 'application/json'}
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload).encode()
    if secret:
        headers['X-Bootstrap-Secret'] = secret
    try:
        with HTTP.open(request.Request(url, data=data, headers=headers), timeout=60) as response:  # nosec B310 -- URL discovered from Cloudflare
            return json.load(response)
    except (error.URLError, TimeoutError, ValueError):
        raise DeployError('Hub request failed; response was not logged. Check saved deployment state before retrying bootstrap.') from None


def provision(account, name, api, directory, existing=False, bootstrap=None,
              runner=wrangler, build=None, hub_request=get_json, report=print):
    if existing and bootstrap is not None:
        raise DeployError('Bootstrap cannot be combined with --existing updates.')
    state_path = directory / 'state.json'
    template = tomllib.loads((SERVER / 'wrangler.toml').read_text())
    # Build and verify signed client artifacts before making remote changes.
    if build is not None:
        build()
    remote = api.settings(name)
    if state_path.exists():
        state = json.loads(state_path.read_text())
        if (state['account_id'], state['worker_name']) != (account, name):
            raise DeployError('Saved deployment belongs to a different account or Worker.')
        if (existing or state.get('worker_created') or state.get('verified')) and not remote:
            raise DeployError('Existing Worker no longer exists. Refusing to create a replacement.')
        if state.get('existing') and bootstrap is not None:
            raise DeployError('Bootstrap cannot be used with an existing deployment.')
    elif existing:
        if not remote:
            raise DeployError('--existing requires an existing Worker; nothing was created.')
        found = bindings(remote)
        db_id = found.get('DB', {}).get('id')
        if not db_id or not all(found.get(key, {}).get('type') == 'secret_text' for key in SECRET_NAMES[:2]):
            raise DeployError('Existing Worker must have a DB binding and both required secrets.')
        db = api.call('GET', '/d1/database/' + db_id)
        state = {'account_id': account, 'worker_name': name, 'database_name': db['name'],
                 'database_id': db_id, 'deployment_id': found.get('HUB_DEPLOYMENT_ID', {}).get('text') or uuid.uuid4().hex,
                 'extra_vars': {key: val['text'] for key, val in found.items() if val['type'] == 'plain_text' and key not in SECRET_NAMES},
                 'existing': True, 'adoption_pending': True,
                 'previous_marker': found.get('HUB_DEPLOYMENT_ID', {}).get('text')}
        # Explicit update of this named Worker; preserve its real DB and secrets.
        private_json(state_path, state)
    else:
        if remote or list(api.databases(name + '-db')):
            raise DeployError('That Worker or database name already exists. Choose another name, or use --existing for an explicitly intended update.')
        state = {'account_id': account, 'worker_name': name, 'database_name': name + '-db',
                 'deployment_id': uuid.uuid4().hex}
        # Durable intent precedes database creation: lost replies resume by name.
        private_json(state_path, state)
    if not state.get('database_id'):
        databases = list(api.databases(state['database_name']))
        if len(databases) > 1:
            raise DeployError('Database name is ambiguous; refusing to choose.')
        db = databases[0] if databases else api.call('POST', '/d1/database', {'name': state['database_name']})
        state['database_id'] = db['uuid']
        private_json(state_path, state)
    api.call('GET', '/d1/database/' + state['database_id'])
    if remote:
        state['extra_vars'] = {key: val['text'] for key, val in bindings(remote).items() if val['type'] == 'plain_text' and key not in SECRET_NAMES}
    config = generate_config(state, template)
    config_path = directory / 'wrangler.json'
    private_json(config_path, config)
    secret_path = None
    if remote:
        check_worker(remote, state)
    else:
        if state.get('existing'):
            raise DeployError('Existing Worker disappeared; refusing to replace it.')
        secret_path = directory / 'secrets.json'
        if secret_path.exists():
            values = json.loads(secret_path.read_text())
        else:
            values = {key: secrets.token_hex(32) for key in SECRET_NAMES}
            private_json(secret_path, values)
    report('Deployment identity and database binding resolved.')
    # Create the account's workers.dev namespace only if not already configured.
    subdomain = api.call('GET', '/workers/subdomain', missing_ok=True)
    if not subdomain or not subdomain.get('subdomain'):
        subdomain = api.call('PUT', '/workers/subdomain', {'subdomain': 'hub-' + state['deployment_id'][:12]})
    suffix = subdomain['subdomain']
    if not re.fullmatch(r'[a-z0-9-]+', suffix):
        raise DeployError('Cloudflare returned an invalid workers.dev subdomain.')
    state['url'] = f'https://{name}.{suffix}.workers.dev'
    state['verified'] = False
    private_json(state_path, state)
    runner(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', str(config_path)])
    report('Database migrations completed.')
    deploy_args = ['deploy', '--config', str(config_path)]
    if secret_path is not None:
        deploy_args += ['--secrets-file', str(secret_path)]
    runner(deploy_args)
    check_worker(api.settings(name), {**state, 'adoption_pending': False})
    state['adoption_pending'] = False
    state['worker_created'] = True
    private_json(state_path, state)
    report('Worker and secrets deployed together with public setup locked.')
    health = hub_request(state['url'] + '/v2/health')
    manifest = hub_request(state['url'] + '/v2/client/latest')
    if not health.get('ok') or health.get('api_versions') != ['v2'] or not health.get('encryption_required'):
        raise DeployError('Deployed hub failed protocol/encryption health verification.')
    skill = manifest.get('skill') or {}
    version_ok = lambda value: bool(re.fullmatch(r'2\.\d+\.\d+', str(value)))
    hash_ok = lambda value: bool(re.fullmatch(r'[a-f0-9]{64}', str(value)))
    if not (hash_ok(manifest.get('sha256')) and hash_ok(skill.get('sha256'))
            and version_ok(manifest.get('version')) and version_ok(skill.get('version'))
            and manifest.get('download_url') == state['url'] + '/v2/client/download/hub'
            and skill.get('url') == state['url'] + '/v2/client/download/skill.tar.gz'):
        raise DeployError('Deployed hub has an invalid client manifest.')
    if bootstrap is not None:
        receipt_path = directory / 'owner-enrollment.json'
        if state.get('bootstrap_started') and not receipt_path.exists():
            raise DeployError('An earlier bootstrap may have committed without a saved reply. Setup is locked; inspect the server before retrying. No duplicate was created.')
        if not receipt_path.exists():
            values = json.loads((directory / 'secrets.json').read_text())
            private_json(config_path, generate_config(state, template, unlocked=True))
            try:
                runner(['deploy', '--config', str(config_path)])
                state['bootstrap_started'] = True
                private_json(state_path, state)
                receipt = hub_request(state['url'] + '/v2/families', bootstrap, values['BOOTSTRAP_SECRET'])
                if not receipt.get('provisioning_code') or not receipt.get('member', {}).get('family_id'):
                    raise DeployError('Bootstrap response is incomplete; inspect server before retrying.')
                private_json(receipt_path, receipt)
            finally:
                private_json(config_path, config)
                runner(['deploy', '--config', str(config_path)])
            report('First circle created; setup re-locked. Private owner-enrollment.json saved.')
    state['verified'] = True
    private_json(state_path, state)
    report('Verified hub URL: ' + state['url'])
    report('Private deployment directory: ' + str(directory))
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', required=True, help='Worker name in your Cloudflare account')
    parser.add_argument('--existing', action='store_true', help='Explicitly update the named existing Worker, discovering its DB; never create a replacement')
    parser.add_argument('--bootstrap-file', type=Path, help='JSON with name, owner_name, owner_email for a new hub; provisioning response stays in a private file')
    args = parser.parse_args(argv)
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
    if not re.fullmatch('[a-fA-F0-9]{32}', account) or not token:
        parser.error('Set CLOUDFLARE_ACCOUNT_ID (32 hex digits) and CLOUDFLARE_API_TOKEN using secure environment settings.')
    if not re.fullmatch('[a-z][a-z0-9-]{0,48}[a-z0-9]', args.name):
        parser.error('--name must be 2–50 lowercase letters/digits/hyphens, starting with a letter and ending with a letter/digit.')
    bootstrap = None
    if args.bootstrap_file:
        try:
            bootstrap = json.loads(args.bootstrap_file.read_text())
        except (OSError, ValueError):
            parser.error('--bootstrap-file must be a readable JSON file; its contents were not logged.')
        if not isinstance(bootstrap, dict) or set(bootstrap) != {'name', 'owner_name', 'owner_email'} or not all(isinstance(v, str) and v.strip() for v in bootstrap.values()):
            parser.error('--bootstrap-file must contain nonempty name, owner_name and owner_email only.')
    directory = SERVER / '.deployments' / account / args.name
    try:
        with deployment_lock(directory):
            provision(account, args.name, Cloudflare(account, token), directory,
                      existing=args.existing, bootstrap=bootstrap,
                      build=lambda: run_command(['npm', 'run', 'build']))
    except (DeployError, OSError, ValueError) as exc:
        # Never dump response bodies, credential values or Python tracebacks.
        print('Deployment stopped: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
