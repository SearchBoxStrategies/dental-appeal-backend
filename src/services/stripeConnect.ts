import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

// Create a Stripe Connect account for an affiliate (Express account)
export async function createConnectAccount(affiliateId: number, email: string, fullName: string) {
  try {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
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

// Transfer funds to a Connect account
export async function transferToAffiliate(affiliateStripeAccountId: string, amount: number, currency: string = 'usd', description: string) {
  try {
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      destination: affiliateStripeAccountId,
      transfer_group: `commission_payout_${Date.now()}`,
      description,
    });

    return transfer;
  } catch (error) {
    console.error('Error transferring funds:', error);
    throw error;
  }
}

// Webhook handler for Connect account updates
export async function handleConnectWebhook(event: Stripe.Event) {
  const { db } = await import('../db');
  
  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const affiliateId = account.metadata?.affiliateId;
      
      if (affiliateId) {
        const isActive = account.charges_enabled && account.payouts_enabled;
        await db.query(
          `UPDATE affiliates 
           SET stripe_account_status = $1,
               stripe_onboarded_at = CASE WHEN $1 = 'verified' AND stripe_onboarded_at IS NULL THEN NOW() ELSE stripe_onboarded_at END,
               auto_payout_enabled = $2
           WHERE id = $3`,
          [isActive ? 'verified' : 'pending', isActive, affiliateId]
        );
        
        console.log(`Updated affiliate ${affiliateId} Connect status to ${isActive ? 'verified' : 'pending'}`);
      }
      break;
    }
    
    case 'transfer.created':
      console.log(`Transfer created: ${event.data.object.id}`);
      break;
      
    case 'transfer.paid':
      console.log(`Transfer paid: ${event.data.object.id}`);
      break;
      
    case 'transfer.failed':
      console.error(`Transfer failed: ${event.data.object.id}`);
      break;
  }
  
  return { received: true };
}

export default stripe;
