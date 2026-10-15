-- 007: Remove the ADA CDT descriptor text from the 38 starter codes until the code set is
-- licensed. The codes themselves stay so the picker still lists common codes by category.
-- Licensed descriptions are loaded later with scripts/importProcedureCodes (see docs/procedure-codes.md).
-- Run once in the Supabase SQL editor. Safe to re-run.

UPDATE cdt_codes
SET description = '', updated_at = NOW()
WHERE edition = 'starter' AND description <> '';
