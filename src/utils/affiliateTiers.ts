// src/utils/affiliateTiers.ts
import { db } from '../db';

// Program terms: tier is set by paid conversions in the current calendar month.
//   Standard 20% (default) | Pro 25% (5+ conversions/month) | Partner 30% (10+ conversions/month)
export const TIERS = [
  { name: 'Partner', rate: 30, minMonthlyConversions: 10 },
  { name: 'Pro', rate: 25, minMonthlyConversions: 5 },
  { name: 'Standard', rate: 20, minMonthlyConversions: 0 },
] as const;

export interface AffiliateTier {
  rate: number;
  name: string;
  referralCount: number; // paid conversions this calendar month
}

export interface AffiliateTierWithId extends AffiliateTier {
  affiliateId: number;
}

export interface NextTierInfo {
  nextTier: string | null;
  nextRate: number | null;
  conversionsNeeded: number | null;
  monthlyConversions: number;
}

/**
 * Get tier based on this month's conversion count (pure function)
 */
export function getTierByConversionCount(monthlyConversions: number): { rate: number; name: string } {
  const tier = TIERS.find(t => monthlyConversions >= t.minMonthlyConversions)!;
  return { rate: tier.rate, name: tier.name };
}

/**
 * Number of referred practices that made their first payment this calendar month
 */
export async function getMonthlyConversions(affiliateId: number): Promise<number> {
  const { rows: [row] } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM affiliate_referrals
     WHERE affiliate_id = $1
       AND converted_at >= date_trunc('month', NOW())`,
    [affiliateId]
  );
  return row?.count || 0;
}

/**
 * Get affiliate tier based on this month's paid conversions
 */
export async function getAffiliateTier(affiliateId: number): Promise<AffiliateTier> {
  const referralCount = await getMonthlyConversions(affiliateId);
  const tier = getTierByConversionCount(referralCount);

  return {
    rate: tier.rate,
    name: tier.name,
    referralCount
  };
}

/**
 * Get affiliate tier for a specific practice (based on who referred them)
 */
export async function getAffiliateTierByPractice(practiceId: number): Promise<AffiliateTierWithId | null> {
  const { rows: [practice] } = await db.query(
    `SELECT referred_by_affiliate_id
     FROM practices
     WHERE id = $1 AND referred_by_affiliate_id IS NOT NULL`,
    [practiceId]
  );

  if (!practice?.referred_by_affiliate_id) {
    return null;
  }

  const tier = await getAffiliateTier(practice.referred_by_affiliate_id);
  return {
    ...tier,
    affiliateId: practice.referred_by_affiliate_id
  };
}

/**
 * Update the affiliate's tier and commission_rate columns to match their current tier
 */
export async function updateAffiliateTierColumn(affiliateId: number): Promise<void> {
  const tier = await getAffiliateTier(affiliateId);

  await db.query(
    `UPDATE affiliates
     SET tier = $1, commission_rate = $2
     WHERE id = $3`,
    [tier.name.toLowerCase(), tier.rate, affiliateId]
  );

  console.log(`✅ Updated affiliate ${affiliateId} to ${tier.name} tier (${tier.rate}%) with ${tier.referralCount} conversions this month`);
}

/**
 * Get info about the next tier the affiliate can reach this month
 */
export async function getNextTierInfo(affiliateId: number): Promise<NextTierInfo> {
  const monthlyConversions = await getMonthlyConversions(affiliateId);
  const next = [...TIERS].reverse().find(t => monthlyConversions < t.minMonthlyConversions);

  return {
    nextTier: next?.name ?? null,
    nextRate: next?.rate ?? null,
    conversionsNeeded: next ? next.minMonthlyConversions - monthlyConversions : null,
    monthlyConversions,
  };
}

/**
 * Fix all affiliates - recalculate and update their tiers based on this month's conversions
 */
export async function fixAllAffiliateTiers(): Promise<void> {
  const { rows: affiliates } = await db.query(
    `SELECT id FROM affiliates`
  );

  for (const affiliate of affiliates) {
    await updateAffiliateTierColumn(affiliate.id);
  }

  console.log(`✅ Fixed tiers for ${affiliates.length} affiliates`);
}
