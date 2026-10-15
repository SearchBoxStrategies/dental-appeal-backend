-- 008: One-row heartbeat table. Supabase pauses Free-plan projects after a week without
-- database activity; updating this row (a real write) every few hours prevents that.
-- Run once in the Supabase SQL editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS system_heartbeat (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pinged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source VARCHAR(20)
);

INSERT INTO system_heartbeat (id, pinged_at, source) VALUES (1, NOW(), 'migration')
ON CONFLICT (id) DO NOTHING;
