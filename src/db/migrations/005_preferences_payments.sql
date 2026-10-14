-- 005: Fixes found in the full test run.
--  - email_preferences table (the Notifications page read and wrote it, but it never existed)
--  - one payments row per Stripe invoice or refund, so revenue totals can't double count
--  - referrals that already converted get the 'converted' status
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code.
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS email_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  appeal_updates BOOLEAN NOT NULL DEFAULT TRUE,
  payment_receipts BOOLEAN NOT NULL DEFAULT TRUE,
  marketing_emails BOOLEAN NOT NULL DEFAULT FALSE,
  weekly_digest BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stripe reference: the invoice id for payments, 'refund:<charge>:<cumulative cents>' for refunds.
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_ref_uidx
  ON payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

UPDATE affiliate_referrals
SET status = 'converted'
WHERE converted_at IS NOT NULL AND status IS DISTINCT FROM 'converted';

COMMIT;
