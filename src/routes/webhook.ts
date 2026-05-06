import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { handleWebhookEvent } from '../services/stripe';

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

// Use the raw body for webhook signature verification
router.post('/stripe', (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  const rawBody = (req as any).rawBody;
  
  let event: Stripe.Event;
  
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(401).json({ error: 'Webhook signature verification failed' });
  }
  
  handleWebhookEvent(event)
    .then(() => res.json({ received: true }))
    .catch((err) => {
      console.error('Webhook handler error:', err);
      res.status(500).json({ error: 'Webhook handler failed' });
    });
});

export default router;
