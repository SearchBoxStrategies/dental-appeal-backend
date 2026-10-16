-- 011: Team accounts, dentist sign-off, two-step sign-in for clinic users, and document files
-- stored outside the database.
-- Run once in the Supabase SQL editor BEFORE deploying the matching backend code. Safe to re-run.

BEGIN;

-- Roles inside a practice: 'owner' manages the team and billing; 'staff' does everything else.
-- is_dentist is separate: only dentists can approve clinical notes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS practice_role VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dentist BOOLEAN NOT NULL DEFAULT FALSE;

-- Everyone who signed up so far is their practice's owner.
UPDATE users SET practice_role = 'owner'
WHERE practice_role IS NULL AND practice_id IS NOT NULL
  AND COALESCE(user_type, 'clinic') = 'clinic' AND COALESCE(is_admin, false) = false;

CREATE TABLE IF NOT EXISTS practice_invites (
  id SERIAL PRIMARY KEY,
  practice_id INTEGER NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  practice_role VARCHAR(10) NOT NULL,
  is_dentist BOOLEAN NOT NULL DEFAULT FALSE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS practice_invites_practice_idx ON practice_invites (practice_id);

-- Which team member approved the dentist's note.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS dentist_note_approved_by_user_id INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

-- Documents: new uploads are saved as encrypted files; file_url (base64) stays for older rows.
ALTER TABLE claim_documents ADD COLUMN IF NOT EXISTS storage_key TEXT;
ALTER TABLE claim_documents ALTER COLUMN file_url DROP NOT NULL;

COMMIT;
