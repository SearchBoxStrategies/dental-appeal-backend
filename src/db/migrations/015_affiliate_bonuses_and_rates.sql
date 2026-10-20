-- 015: Affiliate program v2.
--  * Commission rows get a kind: normal commission, sign-on bonus, or loyalty bonus.
--  * New default rate is 25% (Standard tier). Tiers: Standard 25% (1-4 active clinics),
--    Pro 30% (5-14), Partner 35% (15+). The app recalculates tiers daily.
-- Run once in the Supabase SQL editor. Safe to re-run.

ALTER TABLE affiliate_commissions ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'commission';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'affiliate_commissions'::regclass AND conname = 'affiliate_commissions_kind_check'
  ) THEN
    ALTER TABLE affiliate_commissions
      ADD CONSTRAINT affiliate_commissions_kind_check
      CHECK (kind IN ('commission', 'signon_bonus', 'loyalty_6', 'loyalty_12'));
  END IF;
END $$;

ALTER TABLE affiliates ALTER COLUMN commission_rate SET DEFAULT 25;

UPDATE affiliates
SET commission_rate = 25
WHERE commission_rate = 20
  AND tier = 'standard'
  AND deleted_at IS NULL;
