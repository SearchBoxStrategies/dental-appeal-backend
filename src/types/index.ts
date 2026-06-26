export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  is_admin?: boolean;
  email_verified?: boolean;
  user_type?: 'clinic' | 'affiliate' | 'admin';
  two_factor_enabled?: boolean;
  affiliate?: {
    code: string;
    is_active: boolean;
    approved_at: string | null;
    commission_rate: number;
    tier: string;
    stats: {
      clicks: number;
      signups: number;
      conversions: number;
      earnings: number;
      pending: number;
    };
  } | null;
}

export interface Practice {
  id: string;
  name: string;
  subscriptionStatus: string;
}

export interface Claim {
  id: string;
  practice_id: string;
  patient_name: string;
  patient_dob: string;
  insurance_company: string;
  policy_number: string | null;
  claim_number: string | null;
  procedure_codes: string[];
  denial_reason: string;
  service_date: string;
  amount_claimed: string | null;
  amount_denied: string | null;
  status: 'pending' | 'appealed' | 'resolved';
  created_at: string;
  created_by_name?: string;
  appeals?: AppealSummary[];
}

export interface AppealSummary {
  id: string;
  status: string;
  model_used: string;
  created_at: string;
}

export interface Appeal {
  id: string;
  claim_id: string;
  letter_content: string;
  model_used: string;
  status: string;
  created_at: string;
  patient_name: string;
  insurance_company: string;
  claim_number: string | null;
  procedure_codes: string[];
  denial_reason: string;
  service_date: string;
}

export interface Stats {
  totalClaims: number;
  totalAppeals: number;
  appealsThisMonth: number;
}
