-- 006: Procedure code list ready for yearly updates.
--  - system: 'CDT' (ADA, US) or 'USCLS' (CDA, Canada)
--  - edition: the code set's year, e.g. '2026'
--  - is_active: false once a code is retired in a later edition (kept so old claims still show it)
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code.
-- Safe to re-run.

BEGIN;

ALTER TABLE cdt_codes ADD COLUMN IF NOT EXISTS system VARCHAR(10) NOT NULL DEFAULT 'CDT';
ALTER TABLE cdt_codes ADD COLUMN IF NOT EXISTS edition VARCHAR(10);
ALTER TABLE cdt_codes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE cdt_codes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The 38 starter codes predate licensed imports; mark them so they're easy to tell apart.
UPDATE cdt_codes SET edition = 'starter' WHERE edition IS NULL;

CREATE INDEX IF NOT EXISTS cdt_codes_active_idx ON cdt_codes (system, is_active);

COMMIT;
