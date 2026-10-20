// src/utils/affiliateTiers.ts
import { db } from '../db';

// Program terms: the tier is set by how many of the affiliate's referred clinics are currently paying.
//   Standard 25% (1-4 active clinics) | Pro 30% (5-14) | Partner 35% (15+)
export const TIERS = [
  { name: 'Partner', rate: 35, minActiveClinics: 15 },
  { name: 'Pro', rate: 30, minActiveClinics: 5 },
  { name: 'Standard', rate: 25, minActiveClinics: 0 },
] as const;

export const DEFAULT_RATE = 25;

export interface AffiliateTier {
  rate: number;
  name: string;
  referralCount: number; // referred clinics that are currently paying
}

export interface AffiliateTierWithId extends AffiliateTier {
  affiliateId: number;
}

export interface NextTierInfo {
  nextTier: string | null;
  nextRate: number | null;
  clinicsNeeded: number | null;
  activeClinics: number;
}

/**
 * Get tier based on the number of active paying clinics (pure function)
 */
export function getTierByActiveClinics(activeClinics: number): { rate: number; name: string } {
  const tier = TIERS.find(t => activeClinics >= t.minActiveClinics)!;
  return { rate: tier.rate, name: tier.name };
}

/**
 * Referred clinics whose subscription is active right now
 */
export async function getActiveClinics(affiliateId: number): Promise<number> {
  const { rows: [row] } = await db.query(
    `SELECT COUNT(DISTINCT p.id)::int AS count
     FROM affiliate_referrals ar
     JOIN practices p ON p.id = ar.practice_id
     WHERE ar.affiliate_id = $1
       AND ar.converted_at IS NOT NULL
       AND p.subscription_status = 'active'
       AND p.deleted_at IS NULL`,
    [affiliateId]
  );
  return row?.count || 0;
}

/**
 * Get affiliate tier based on active paying clinics.
 * `atLeast` covers a payment being processed for a clinic whose status has not been saved as active yet.
 */
export async function getAffiliateTier(affiliateId: number, atLeast = 0): Promise<AffiliateTier> {
  const referralCount = Math.max(await getActiveClinics(affiliateId), atLeast);
  const tier = getTierByActiveClinics(referralCount);

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

  // This clinic is paying, so it counts even if its status was not saved yet.
  const tier = await getAffiliateTier(practice.referred_by_affiliate_id, 1);
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

  console.log(`✅ Updated affiliate ${affiliateId} to ${tier.name} tier (${tier.rate}%) with ${tier.referralCount} active clinics`);
}

/**
 * Get info about the next tier the affiliate can reach
 */
export async function getNextTierInfo(affiliateId: number): Promise<NextTierInfo> {
  const activeClinics = await getActiveClinics(affiliateId);
  const next = [...TIERS].reverse().find(t => activeClinics < t.minActiveClinics);

  return {
    nextTier: next?.name ?? null,
    nextRate: next?.rate ?? null,
    clinicsNeeded: next ? next.minActiveClinics - activeClinics : null,
    activeClinics,
  };
}

/**
 * Recalculate and update every affiliate's tier from their active clinics
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
