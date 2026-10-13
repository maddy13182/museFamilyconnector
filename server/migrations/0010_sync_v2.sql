-- Sync v2 + E2EE key lifecycle (spec §1.1).
--
-- MERGE-COORDINATION STUB: this file carries only the two topic columns
-- Server-B needs for the write gate (rotation_required, current_epoch).
-- The Server-A worker owns the authoritative full 0010 (topic_read_state,
-- topic_key_epochs, identity_key_id on topic_key_envelopes, and the
-- backfill below). When the branches merge, the full superset version of
-- this file wins and this stub is dropped — the column definitions here
-- mirror spec §1.1 exactly so behavior is identical either way.

-- Key epoch counter. E2EE topics with a current_key_id get epoch 1
-- (commitment NULL, grandfathered); plaintext topics stay at epoch 0.
ALTER TABLE topics ADD COLUMN current_epoch INTEGER NOT NULL DEFAULT 0;
UPDATE topics SET current_epoch = 1 WHERE e2ee = 1 AND current_key_id IS NOT NULL;

-- Removal / from-join transitions require a fresh key before new encrypted
-- writes are accepted (set by the removal handler and from-join accept for
-- E2EE topics; cleared by a successful keys/commit).
ALTER TABLE topics ADD COLUMN rotation_required INTEGER NOT NULL DEFAULT 0;
