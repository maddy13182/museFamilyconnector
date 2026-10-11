-- Family Hub schema v0.2.0 — circle kind on families.
-- 'family' keeps the owner/parent/kid role set; 'general' will use
-- owner/admin/member (v0.3.0+). Plain SQLite only (no D1-specific functions).
-- Existing rows default to 'family', preserving v0.1.x behavior.
ALTER TABLE families ADD COLUMN kind TEXT NOT NULL DEFAULT 'family';
