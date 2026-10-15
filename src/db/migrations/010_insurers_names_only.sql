-- 010: Insurer list fixes.
--  1. Remove the placeholder appeals addresses seeded at launch ("P.O. Box 1234" and similar).
--     They were not real; appeals now use the address printed on the denial notice.
--  2. Add a country to each insurer.
--  3. Add the main US and Canadian dental insurers, names only (no addresses until verified).
--  4. Canadian insurers have no standard appeal window: leave it empty so the app asks the
--     clinic to take the deadline from the denial notice instead of assuming 180 days.
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code. Safe to re-run.

BEGIN;

ALTER TABLE insurance_companies ADD COLUMN IF NOT EXISTS country VARCHAR(2) NOT NULL DEFAULT 'US';

-- 1. Placeholder addresses (all of the form "<Name> Appeals Department\nP.O. Box <digits>\n...").
UPDATE insurance_companies
SET appeals_address = NULL, appeals_department = NULL, updated_at = NOW()
WHERE position('Appeals Department\nP.O. Box' in appeals_address) > 0;

-- 3. Main insurers, names only.
INSERT INTO insurance_companies (name, code, country, appeal_window_days, is_active, created_at, updated_at)
SELECT v.name, v.code, v.country, v.window_days, TRUE, NOW(), NOW()
FROM (VALUES
  -- United States
  ('United Concordia', 'UCCI', 'US', 180),
  ('Anthem', 'ANTHEM', 'US', 180),
  ('Lincoln Financial', 'LINCOLN', 'US', 180),
  ('DentaQuest', 'DENTAQUEST', 'US', 180),
  ('Liberty Dental Plan', 'LIBERTY', 'US', 180),
  ('GEHA', 'GEHA', 'US', 180),
  ('Dominion National', 'DOMINION', 'US', 180),
  ('Renaissance Dental', 'RENAISSANCE', 'US', 180),
  ('Mutual of Omaha', 'MUTUALOMAHA', 'US', 180),
  ('Physicians Mutual', 'PHYSMUTUAL', 'US', 180),
  ('TRICARE Dental Program', 'TRICARE', 'US', 180),
  ('Medicaid (state dental program)', 'MEDICAID', 'US', 180),
  -- Canada (no standard appeal window)
  ('Sun Life', 'SUNLIFE', 'CA', NULL),
  ('Manulife', 'MANULIFE', 'CA', NULL),
  ('Canada Life', 'CANADALIFE', 'CA', NULL),
  ('Green Shield Canada', 'GSC', 'CA', NULL),
  ('Desjardins Insurance', 'DESJARDINS', 'CA', NULL),
  ('iA Financial Group', 'IA', 'CA', NULL),
  ('Beneva', 'BENEVA', 'CA', NULL),
  ('Empire Life', 'EMPIRE', 'CA', NULL),
  ('Equitable Life of Canada', 'EQUITABLE', 'CA', NULL),
  ('RBC Insurance', 'RBC', 'CA', NULL),
  ('Medavie Blue Cross', 'MEDAVIE', 'CA', NULL),
  ('Pacific Blue Cross', 'PBC', 'CA', NULL),
  ('Alberta Blue Cross', 'ABC', 'CA', NULL),
  ('Saskatchewan Blue Cross', 'SBC', 'CA', NULL),
  ('Manitoba Blue Cross', 'MBC', 'CA', NULL),
  ('Ontario Blue Cross', 'OBC', 'CA', NULL),
  ('Quebec Blue Cross', 'QBC', 'CA', NULL),
  ('ClaimSecure', 'CLAIMSECURE', 'CA', NULL),
  ('Chambers Plan', 'CHAMBERS', 'CA', NULL),
  ('Canadian Dental Care Plan (CDCP)', 'CDCP', 'CA', NULL),
  ('Non-Insured Health Benefits (NIHB)', 'NIHB', 'CA', NULL)
) AS v(name, code, country, window_days)
WHERE NOT EXISTS (SELECT 1 FROM insurance_companies ic WHERE lower(ic.name) = lower(v.name));

-- 4. Make sure Canadian insurers carry no assumed window.
UPDATE insurance_companies SET appeal_window_days = NULL WHERE country = 'CA' AND appeal_window_days IS NOT NULL;

COMMIT;
