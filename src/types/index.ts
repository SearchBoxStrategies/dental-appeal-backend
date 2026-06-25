export interface JwtPayload {
  userId: string;
  practiceId: string;
  role: string;
  practiceName: string;
  export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  is_admin?: boolean;
  email_verified?: boolean;
  user_type?: 'clinic' | 'affiliate' | 'admin';
  two_factor_enabled?: boolean; // ADD THIS
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
