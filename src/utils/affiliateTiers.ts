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

export interface NextTierInfo {
  nextTier: string | null;
  nextRate: number | null;
  conversionsNeeded: number | null;
}

/**
 * Get tier based on conversion count (pure function)
 */
export function getTierByConversionCount(conversionCount: number): { rate: number; name: string } {
  if (conversionCount >= 50) {
    return { rate: 25, name: 'Partner' };
  }
  if (conversionCount >= 10) {
    return { rate: 20, name: 'Pro' };
  }
  return { rate: 15, name: 'Standard' };
}

/**
 * Get affiliate tier based on number of successful conversions
 * Uses total_conversions from the affiliates table
 */
export async function getAffiliateTier(affiliateId: number): Promise<AffiliateTier> {
  const { rows: [affiliate] } = await db.query(
    `SELECT total_conversions FROM affiliates WHERE id = $1`,
    [affiliateId]
  );
  
  const referralCount = affiliate?.total_conversions || 0;
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
  
  console.log(`✅ Updated affiliate ${affiliateId} to ${tier.name} tier (${tier.rate}%) with ${tier.referralCount} conversions`);
}

/**
 * Get info about the next tier the affiliate can achieve
 */
export async function getNextTierInfo(affiliateId: number): Promise<NextTierInfo> {
  const { rows: [affiliate] } = await db.query(
    `SELECT total_conversions FROM affiliates WHERE id = $1`,
    [affiliateId]
  );
  
  const conversionCount = affiliate?.total_conversions || 0;
  
  if (conversionCount < 10) {
    return {
      nextTier: 'Pro',
      nextRate: 20,
      conversionsNeeded: 10 - conversionCount,
    };
  } else if (conversionCount < 50) {
    return {
      nextTier: 'Partner',
      nextRate: 25,
      conversionsNeeded: 50 - conversionCount,
    };
  } else {
    return {
      nextTier: null,
      nextRate: null,
      conversionsNeeded: null,
    };
  }
}

/**
 * Fix all affiliates - recalculate and update their tiers based on actual conversions
 * Run this once after deploying to fix any incorrect tiers
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
