import { Router } from 'express';
import { db } from '../db';
import { authenticate, requireOwner } from '../middleware/auth';
import { TRIAL_DAYS } from '../middleware/subscription';
import { createCheckoutSession, createCustomerPortalSession } from '../services/stripe';

const router = Router();

// Get current subscription status
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;

    const { rows: [practice] } = await db.query(
      `SELECT subscription_status, stripe_customer_id, total_paid, last_payment_date,
              created_at + make_interval(days => $2) AS trial_ends_at
       FROM practices WHERE id = $1`,
      [practiceId, TRIAL_DAYS]
    );

    // Only practices still on the free trial (never subscribed) get a countdown.
    let trialDaysLeft: number | null = null;
    let trialEndsAt: string | null = null;
    if (practice?.subscription_status === 'trial' && practice.trial_ends_at) {
      const ends = new Date(practice.trial_ends_at);
      trialEndsAt = ends.toISOString();
      trialDaysLeft = Math.max(0, Math.ceil((ends.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    }

    res.json({
      status: practice?.subscription_status || 'inactive',
      stripeCustomerId: practice?.stripe_customer_id,
      totalPaid: practice?.total_paid || 0,
      lastPaymentDate: practice?.last_payment_date,
      trialDaysLeft,
      trialEndsAt,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create checkout session for subscription
router.post('/checkout', authenticate, requireOwner, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    const userId = req.user!.userId;
    const { referralCode } = req.body; // ADDED - get referral code from request body
    const priceId = process.env.STRIPE_PRICE_ID!;

    const { rows: [practice] } = await db.query(
      'SELECT stripe_customer_id FROM practices WHERE id = $1',
      [practiceId]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'https://app.dentalappeal.claims';

    const session = await createCheckoutSession({
      customerId: practice?.stripe_customer_id,
      priceId,
      successUrl: `${frontendUrl}/billing?success=true`,
      cancelUrl: `${frontendUrl}/billing?canceled=true`,
      userId,
      practiceId,
      referralCode, // ADDED - pass referral code to Stripe
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create customer portal session for managing subscription
router.post('/portal', authenticate, requireOwner, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;

    const { rows: [practice] } = await db.query(
      'SELECT stripe_customer_id FROM practices WHERE id = $1',
      [practiceId]
    );

    if (!practice?.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://app.dentalappeal.claims';

    const session = await createCustomerPortalSession(
      practice.stripe_customer_id,
      `${frontendUrl}/billing`
    );

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

export default router;
