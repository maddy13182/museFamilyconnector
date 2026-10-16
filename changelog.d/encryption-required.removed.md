Protocol 2 makes topic encryption mandatory across server, CLI and Muse skill.
Removes plaintext topics, API v1, the legacy subject cipher and forced partial key
activation. Enrollment registers identities before topic use; creation and child
briefings resume safely after interruption. Subjects rotate atomically with keys;
content writes are guarded at the database transaction. From-join history grants
exclude older keys, and removal rotates for remaining participants. Recipient
identity changes require explicit verification. Recovery words remain in private
files, and enrollment always persists credentials locally before verification.

Requires a fresh database and coordinated signed CLI/skill 2.0.0 releases. Existing
development data is preserved separately; no automatic conversion or deletion.
