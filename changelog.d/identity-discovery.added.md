Introduce identity protocol 1 in server/CLI/skill 2.2.0: one invitation-registered user
and Muse agent per server, live circle memberships and
server-side circle/person discovery. Add bounded, structured discovery across
configured servers, explicit request-local circle context, private invitation
registration and matching-email confirmation, and hosted installation
instructions. Preserve topic/member IDs, encrypted messaging/tasks and key
history boundaries. Remove per-circle credential aggregation and enrollment
reissue workarounds. New installations require a fresh database. No email provider is needed.
Published signed 2.2.0 artifacts must be pinned before server deployment.

Serve a complete venv-based invitation workflow from the hosted server, including
signature/hash verification, exact Python/CLI paths, skill loading, profile-safe
enrollment, post-join conversation checks, and an offline diagnostics exporter.
Persist a private client credential before enrollment and register a request-bound
receipt in the same transaction as membership, keys and code consumption. Exact
retries resume without new credentials; changed requests, revocations and removed
members fail closed. Remove credential-revocation/reissue workarounds and malformed
response fallbacks. Require signed 2.2.0+ server, CLI and skill for fresh setup.
