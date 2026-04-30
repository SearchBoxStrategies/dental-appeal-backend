import { Router } from 'express';
import { db } from '../db';
import { stripe } from '../services/stripe';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/checkout', authenticate, async (req, res) => {
  try {
    const { rows: [practice] } = await db.query(
      'SELECT name, email, stripe_customer_id FROM practices WHERE id = $1',
      [req.user!.practiceId]
    );

    let customerId: string = practice.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: practice.email,
        name: practice.name,
        metadata: { practiceId: req.user!.practiceId },
      });
      customerId = customer.id;
      await db.query(
        'UPDATE practices SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, req.user!.practiceId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.CLIENT_URL}/billing?success=true`,
      cancel_url: `${process.env.CLIENT_URL}/billing?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.post('/portal', authenticate, async (req, res) => {
  try {
    const { rows: [practice] } = await db.query(
      'SELECT stripe_customer_id FROM practices WHERE id = $1',
      [req.user!.practiceId]
    );

    if (!practice.stripe_customer_id) {
      res.status(400).json({ error: 'No billing account found. Subscribe first.' });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: practice.stripe_customer_id,
      return_url: `${process.env.CLIENT_URL}/billing`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

export default router;
