CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50) NOT NULL DEFAULT 'inactive',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'staff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  patient_name VARCHAR(255) NOT NULL,
  patient_dob DATE NOT NULL,
  insurance_company VARCHAR(255) NOT NULL,
  policy_number VARCHAR(255),
  claim_number VARCHAR(255),
  procedure_codes TEXT[] NOT NULL,
  denial_reason TEXT NOT NULL,
  service_date DATE NOT NULL,
  amount_claimed DECIMAL(10, 2),
  amount_denied DECIMAL(10, 2),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id UUID NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  prompt_used TEXT NOT NULL,
  letter_content TEXT NOT NULL,
  model_used VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_practice_id ON users(practice_id);
CREATE INDEX IF NOT EXISTS idx_claims_practice_id ON claims(practice_id);
CREATE INDEX IF NOT EXISTS idx_appeals_practice_id ON appeals(practice_id);
CREATE INDEX IF NOT EXISTS idx_appeals_claim_id ON appeals(claim_id);
