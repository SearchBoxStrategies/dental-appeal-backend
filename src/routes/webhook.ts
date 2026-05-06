import express, { Request, Response } from 'express';
import Stripe from 'stripe';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

router.post('/stripe', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
  
  if (!webhookSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  
  let event: Stripe.Event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error(`⚠️ Webhook signature verification failed: ${err.message}`);
    return res.status(401).json({ error: 'Webhook signature verification failed' });
  }
  
  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object as Stripe.Checkout.Session;
      console.log(`✅ Checkout completed for session: ${session.id}`);
      console.log(`   UserId: ${session.metadata?.userId}`);
      console.log(`   PracticeId: ${session.metadata?.practiceId}`);
      console.log(`   Customer: ${session.customer}`);
      
      // Update the database - UNCOMMENTED
      try {
        const { db } = await import('../db');
        await db.query(
          `UPDATE practices 
           SET subscription_status = 'active', 
               stripe_customer_id = $1,
               stripe_subscription_id = $2
           WHERE id = $3`,
          [session.customer, session.subscription, session.metadata?.practiceId]
        );
        console.log(`✅ Updated practice ${session.metadata?.practiceId} to active`);
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
      }
      break;
      
    case 'invoice.payment_succeeded':
      const invoice = event.data.object as Stripe.Invoice;
      console.log(`💰 Payment succeeded for invoice: ${invoice.id}`);
      break;
      
    case 'customer.subscription.deleted':
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`❌ Subscription cancelled: ${subscription.id}`);
      try {
        const { db } = await import('../db');
        await db.query(
          'UPDATE practices SET subscription_status = $1 WHERE stripe_subscription_id = $2',
          ['cancelled', subscription.id]
        );
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
      }
      break;
      
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }
  
  res.json({ received: true });
});

export default router;
