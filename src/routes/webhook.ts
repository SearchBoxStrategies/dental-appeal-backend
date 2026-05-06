import express, { Request, Response } from 'express';

const router = express.Router();

// This must be the ONLY middleware for this route
router.post('/stripe', express.raw({ type: 'application/json' }), (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  console.log('📨 Webhook received!');
  console.log('Signature:', sig ? `${sig.substring(0, 20)}...` : 'missing');
  console.log('Secret exists:', !!webhookSecret);
  console.log('Body type:', typeof req.body);
  console.log('Is Buffer:', Buffer.isBuffer(req.body));
  
  if (!webhookSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET is not set in environment variables');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  
  // For now, just acknowledge receipt to verify the endpoint works
  // Signature verification will be added once we confirm the route is reachable
  console.log('✅ Webhook endpoint reached. Returning 200.');
  
  res.json({ received: true });
});

export default router;
