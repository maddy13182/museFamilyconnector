- Server: deleted six endpoints with zero clients (clean break, no
  deprecation window): `GET /v1/sync` (superseded by `/v1/sync/topics`),
  `POST /v1/auth/rotate` (re-enroll covers rotation), `GET
  /v1/topics/:tid/export`, `POST /v1/entries/:eid/redact`, and `GET` /
  `PATCH /v1/tasks/:tid` (the CLI uses task `notes` / `done` instead).
- Server: `POST /v1/auth/revoke` is kept — emergency credential
  revocation is security-critical and gets a CLI command (`hub
  token-revoke`) plus a runbook entry instead of being deleted.
