-- 002: Affiliate payout safety
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code.
-- Safe to re-run.

BEGIN;

-- When each commission was earned (drives the 30-day hold).
-- Existing rows are backdated to their period start so they are not held again.
ALTER TABLE affiliate_commissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE affiliate_commissions SET created_at = period_start::timestamptz WHERE created_at IS NULL;
ALTER TABLE affiliate_commissions ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE affiliate_commissions ALTER COLUMN created_at SET NOT NULL;

-- Stripe invoice (or refund) that produced the commission.
-- Unique, so a webhook Stripe delivers twice cannot create two commissions.
ALTER TABLE affiliate_commissions ADD COLUMN IF NOT EXISTS stripe_invoice_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_commissions_stripe_invoice_id_key
  ON affiliate_commissions (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- Statuses: pending -> processing -> paid. Refund reversals are negative 'pending' rows
-- that net against the next payout.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'affiliate_commissions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE affiliate_commissions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_status_check
  CHECK (status IN ('pending', 'processing', 'paid', 'cancelled'));

CREATE INDEX IF NOT EXISTS affiliate_commissions_status_created_idx
  ON affiliate_commissions (status, created_at);

COMMIT;
