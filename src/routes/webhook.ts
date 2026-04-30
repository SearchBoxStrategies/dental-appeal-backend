import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe } from '../services/stripe';
import { db } from '../db';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    res.status(400).send('Missing stripe-signature header');
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).send(`Webhook Error: ${msg}`);
    return;
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        const status = sub.status === 'active' ? 'active' : 'inactive';
        await db.query(
          'UPDATE practices SET subscription_status = $1, stripe_subscription_id = $2 WHERE stripe_customer_id = $3',
          [status, sub.id, customerId]
        );
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        await db.query(
          "UPDATE practices SET subscription_status = 'inactive' WHERE stripe_customer_id = $1",
          [customerId]
        );
        break;
      }
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).send('Webhook handler failed');
    return;
  }

  res.json({ received: true });
});

export default router;
