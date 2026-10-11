- Server: structured JSON request/error logging in the worker — one line per
  request (method, path, status, duration) plus auth-rejection and error
  detail lines. Every line carries the server version; invite/provisioning
  codes in paths are redacted and query strings are never logged. Workers
  Logs enabled via `[observability]` in `wrangler.toml`.
