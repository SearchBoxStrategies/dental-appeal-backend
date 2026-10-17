-- 013: An affiliate's email only has to be unique among affiliates that are not deleted.
-- Deleted (or rejected) affiliates are kept for history, and their email used to block the same
-- person from ever applying again. Case-insensitive, like the sign-up lookup.
-- Run once in the Supabase SQL editor. Safe to re-run.

ALTER TABLE affiliates DROP CONSTRAINT IF EXISTS affiliates_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS affiliates_email_active_key
  ON affiliates (lower(email))
  WHERE deleted_at IS NULL;
