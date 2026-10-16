import Stripe from 'stripe';
import { stripeOptions } from './stripeOptions';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, stripeOptions());

export const SUPPORTED_AFFILIATE_COUNTRIES = ['US', 'CA'] as const;
export type AffiliateCountry = typeof SUPPORTED_AFFILIATE_COUNTRIES[number];

// Country of the platform's own Stripe account. Affiliates in another country are set up as
// cross-border payout recipients, which Stripe requires for transfers across borders.
const PLATFORM_COUNTRY = (process.env.STRIPE_PLATFORM_COUNTRY || 'US').toUpperCase();

// Create a Stripe Connect account for an affiliate (Express account)
export async function createConnectAccount(affiliateId: number, email: string, fullName: string, country: AffiliateCountry = 'US') {
  try {
    const account = await stripe.accounts.create({
      type: 'express',
      country,
      ...(country !== PLATFORM_COUNTRY ? { tos_acceptance: { service_agreement: 'recipient' } } : {}),
      email: email,
      business_type: 'individual',
      individual: {
        first_name: fullName.split(' ')[0],
        last_name: fullName.split(' ').slice(1).join(' ') || 'User',
        email: email,
      },
      capabilities: {
        transfers: { requested: true },
      },
      business_profile: {
        name: 'DentalAppeal Affiliate',
        url: process.env.FRONTEND_URL || 'https://app.dentalappeal.claims',
        product_description: 'Affiliate marketing for dental appeal software',
      },
      metadata: {
        affiliateId: affiliateId.toString(),
      },
    });

    return account;
  } catch (error) {
    console.error('Error creating Connect account:', error);
    throw error;
  }
}

// Create account onboarding link
export async function createAccountOnboardingLink(accountId: string) {
  try {
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL}/affiliate/dashboard?onboarding=refresh`,
      return_url: `${process.env.FRONTEND_URL}/affiliate/dashboard?onboarding=success`,
      type: 'account_onboarding',
    });

    return accountLink;
  } catch (error) {
    console.error('Error creating onboarding link:', error);
    throw error;
  }
}

// Create account login link (for affiliates to manage their Stripe account)
export async function createAccountLoginLink(accountId: string) {
  try {
    const loginLink = await stripe.accounts.createLoginLink(accountId);
    return loginLink;
  } catch (error) {
    console.error('Error creating login link:', error);
    throw error;
  }
}

// Get account status
export async function getAccountStatus(accountId: string) {
  try {
    const account = await stripe.accounts.retrieve(accountId);
    return {
      id: account.id,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      status: account.charges_enabled && account.payouts_enabled ? 'active' : 'pending',
    };
  } catch (error) {
    console.error('Error getting account status:', error);
    return null;
  }
}

// Transfer funds to a Connect account.
// With a payoutKey, the transfer is tagged with it and reused if one already exists, so a
// retried payout is never sent twice (Stripe's own idempotency keys expire after 24h).
export async function transferToAffiliate(
  affiliateStripeAccountId: string,
  amount: number,
  currency: string = 'usd',
  description: string,
  payoutKey?: string
) {
  try {
    if (payoutKey) {
      const existing = await stripe.transfers.list({ transfer_group: payoutKey, limit: 1 });
      if (existing.data[0]) return existing.data[0];
    }

    const transfer = await stripe.transfers.create(
      {
        amount: Math.round(amount * 100), // Convert to cents
        currency,
        destination: affiliateStripeAccountId,
        transfer_group: payoutKey || `commission_payout_${Date.now()}`,
        description,
      },
      payoutKey ? { idempotencyKey: payoutKey } : undefined
    );

    return transfer;
  } catch (error) {
    console.error('Error transferring funds:', error);
    throw error;
  }
}

export default stripe;
