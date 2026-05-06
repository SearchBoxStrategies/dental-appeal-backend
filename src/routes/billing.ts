import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { createCheckoutSession, createCustomerPortalSession } from '../services/stripe';

const router = Router();

// Get current subscription status
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    
    const { rows: [practice] } = await db.query(
      `SELECT subscription_status, stripe_customer_id, total_paid, last_payment_date 
       FROM practices WHERE id = $1`,
      [practiceId]
    );
    
    res.json({
      status: practice?.subscription_status || 'inactive',
      stripeCustomerId: practice?.stripe_customer_id,
      totalPaid: practice?.total_paid || 0,
      lastPaymentDate: practice?.last_payment_date,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create checkout session for subscription
router.post('/checkout', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    const userId = req.user!.userId;
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
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create customer portal session for managing subscription
router.post('/portal', authenticate, async (req, res) => {
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
