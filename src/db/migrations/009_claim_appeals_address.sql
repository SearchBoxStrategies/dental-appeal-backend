-- 009: Where to send the appeal, as printed on the insurer's denial notice. Used when the insurer
-- isn't in our list (or our list has no address for it).
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code. Safe to re-run.

ALTER TABLE claims ADD COLUMN IF NOT EXISTS insurer_appeals_address TEXT;
