- CLI: version contract with the server. `hub` now declares a minimum
  server version (`_MIN_SERVER_VERSION = "0.12.0"`) and, once per
  invocation, checks `GET /v1/health` before running any command: a
  server that is too old (or reports no `api_versions`) fails loudly
  with upgrade instructions instead of breaking silently. The CLI also
  negotiates the API major from the server's advertised `api_versions`
  (v1 today). No backward compatibility with server 0.11.0 / CLI 0.9.0 —
  clean break.
- CLI: new trusted server error codes. HTTP 426 `client_too_old` now
  surfaces the server's plain-language upgrade message; HTTP 410 maps to
  `expired`, trusting the server codes `invite_expired`, `code_expired`,
  `transfer_expired`, and `transfer_recipient_gone`.
