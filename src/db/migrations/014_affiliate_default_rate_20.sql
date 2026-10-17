-- 014: New affiliate applications start at the program's Standard rate (20%), not the old 15%.
-- Approval already sets 20%; this makes pending applications show the right rate too.
-- Deleted applications are history and are left as they were.
-- Run once in the Supabase SQL editor. Safe to re-run.

ALTER TABLE affiliates ALTER COLUMN commission_rate SET DEFAULT 20;

UPDATE affiliates
SET commission_rate = 20
WHERE commission_rate = 15
  AND tier = 'standard'
  AND deleted_at IS NULL;
