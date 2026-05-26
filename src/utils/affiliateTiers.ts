// src/utils/affiliateTiers.ts
import { db } from '../db';

export interface AffiliateTier {
  rate: number;
  name: string;
  referralCount: number;
}

export interface AffiliateTierWithId extends AffiliateTier {
  affiliateId: number;
}

/**
 * Get affiliate tier based on number of successfully referred practices
 */
export async function getAffiliateTier(affiliateId: number): Promise<AffiliateTier> {
  // Count how many practices this affiliate has successfully converted
  const { rows: [countResult] } = await db.query(
    `SELECT COUNT(DISTINCT ar.practice_id) as referral_count
     FROM affiliate_referrals ar
     WHERE ar.affiliate_id = $1 
       AND ar.status = 'converted'
       AND ar.practice_id IS NOT NULL`,
    [affiliateId]
  );
  
  const referralCount = parseInt(countResult?.referral_count || '0');
  
  // Your 3-tier logic
  if (referralCount >= 50) {
    return { rate: 25, name: 'Partner', referralCount };
  }
  if (referralCount >= 10) {
    return { rate: 20, name: 'Pro', referralCount };
  }
  return { rate: 15, name: 'Standard', referralCount };
}

/**
 * Get affiliate tier for a specific practice (based on who referred them)
 */
export async function getAffiliateTierByPractice(practiceId: number): Promise<AffiliateTierWithId | null> {
  const { rows: [referral] } = await db.query(
    `SELECT a.id as affiliate_id
     FROM affiliate_referrals ar
     JOIN affiliates a ON ar.affiliate_id = a.id
     WHERE ar.practice_id = $1 AND ar.status = 'converted'`,
    [practiceId]
  );
  
  if (!referral) {
    return null;
  }
  
  const tier = await getAffiliateTier(referral.affiliate_id);
  return {
    ...tier,
    affiliateId: referral.affiliate_id
  };
}
