-- R1 replay protection (spec §1.2): msg_id extracted from fh1 bodies at
-- POST time. The partial unique index makes a copied ciphertext unable to
-- become a second entry: same (topic_id, msg_id) with the same body is an
-- idempotent retry; same id with a different body is 409 msg_id_conflict.
-- NULL for plaintext bodies (they are never deduplicated this way).
ALTER TABLE entries ADD COLUMN msg_id TEXT NULL;
CREATE UNIQUE INDEX idx_entries_topic_msgid
  ON entries(topic_id, msg_id) WHERE msg_id IS NOT NULL;
