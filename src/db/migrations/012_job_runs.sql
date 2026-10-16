-- 012: Remembers which scheduled jobs already ran in a period (e.g. affiliate payouts once a month),
-- so restarts or several app instances never run them twice.
-- Run once in the Supabase SQL editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS job_runs (
  job VARCHAR(50) NOT NULL,
  period VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job, period)
);
