-- 003: Record appeal outcomes so the app can report real recovered dollars.
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code.
-- Safe to re-run.

BEGIN;

-- What the insurer actually paid after the appeal (may be less than amount_denied).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS amount_recovered DECIMAL(10, 2);

-- When the claim reached a final outcome (won, lost or paid).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Last status change.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE claims ALTER COLUMN updated_at SET DEFAULT NOW();

-- Backfill: claims already resolved get a resolution date so they appear in monthly totals.
UPDATE claims
SET resolved_at = COALESCE(updated_at, created_at)
WHERE status IN ('won', 'lost', 'paid') AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS claims_practice_status_idx ON claims (practice_id, status);
CREATE INDEX IF NOT EXISTS claims_practice_resolved_idx ON claims (practice_id, resolved_at);

COMMIT;
