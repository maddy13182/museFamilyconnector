- Server: `GET /v1/health` now reports the server's actual release version
  (read from `server/package.json` at build time) instead of a stale
  hardcoded `0.1.0`.
