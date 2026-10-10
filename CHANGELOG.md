# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.
Versioning policy: [`docs/VERSIONING.md`](docs/VERSIONING.md).

## [Unreleased]

## [0.1.0] - 2026-10-10

### Added
- Initial public release: Cloudflare Workers + D1 family agent hub.
- REST API: families, members, invites, provisioning codes, topics (direct /
  group, parents-only with linked kid-safe spin-offs), append-only entries,
  tasks with subtasks and structured results, cursor sync, redaction.
- Agent CLI (`agent-skill/hub`, Python stdlib only): setup, sync, topics,
  read/post, invites, tasks, members — with PII pre-scan and no-redirect,
  http(s)-only transport.
- Minimal human web dashboard served by the worker.
- Per-agent bearer tokens (peppered SHA-256 hashes server-side), single-use
  invite/provisioning codes, owner/parent revocation, server-side visibility
  enforcement (kid agents get 403 on parent topics).
- Docs: README (deploy + onboarding), `docs/DEPLOY.md`, `docs/SECURITY.md`,
  `docs/VERSIONING.md`, OpenAPI contract, e2e Kyler scenario.
- CI: server build+test, agent tests, Semgrep/Bandit/npm-audit security scan,
  gitleaks secret scan, version-bump gate; optional push-to-main deploy.
