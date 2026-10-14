-- 004: Appeal workflow: deadlines, follow-up reminders, attachment checklist,
-- dentist sign-off note and letter editing.
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code.
-- Safe to re-run.

BEGIN;

-- How long each insurer allows for an appeal after the denial (days). Most US dental
-- plans allow 180 days; edit per insurer as needed.
ALTER TABLE insurance_companies ADD COLUMN IF NOT EXISTS appeal_window_days INTEGER;
UPDATE insurance_companies SET appeal_window_days = 180 WHERE appeal_window_days IS NULL;
ALTER TABLE insurance_companies ALTER COLUMN appeal_window_days SET DEFAULT 180;

-- Date printed on the denial (EOB) and the last day to file the appeal.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_date DATE;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS appeal_deadline DATE;

-- When the appeal was sent; the follow-up reminder fires 30 days later.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS appealed_at TIMESTAMPTZ;

-- Reminder bookkeeping so each reminder goes out once.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS deadline_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS follow_up_reminder_sent_at TIMESTAMPTZ;

-- Attachment checklist state: {"item-id": true, ...}
ALTER TABLE claims ADD COLUMN IF NOT EXISTS checklist_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Clinical note drafted by the AI, edited and signed off by the dentist.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS dentist_note TEXT;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS dentist_note_approved_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS dentist_note_approved_by VARCHAR(255);

-- Letters can be edited in the app.
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- Backfill: existing claims get a deadline counted from when they were entered, and
-- claims already appealed get a send date so follow-ups work.
UPDATE claims c
SET appeal_deadline = (c.created_at::date + COALESCE(ic.appeal_window_days, 180))
FROM (SELECT id, appeal_window_days FROM insurance_companies) ic
WHERE c.appeal_deadline IS NULL AND ic.id = c.insurance_company_id;

UPDATE claims
SET appeal_deadline = created_at::date + 180
WHERE appeal_deadline IS NULL;

UPDATE claims
SET appealed_at = COALESCE(updated_at, created_at)
WHERE status IN ('appealed', 'under_review') AND appealed_at IS NULL;

CREATE INDEX IF NOT EXISTS claims_deadline_idx ON claims (appeal_deadline)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS claims_appealed_at_idx ON claims (appealed_at)
  WHERE deleted_at IS NULL;

COMMIT;
