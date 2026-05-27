import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { getAffiliateTier, getAffiliateTierByPractice, updateAffiliateTierColumn } from '../utils/affiliateTiers';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

// Helper: Create affiliate commission on first payment
async function createAffiliateCommission(practiceId: number, subscriptionId: string, amount: number) {
  try {
    const { db } = await import('../db');
    
    // Get practice details including affiliate info
    const { rows: [practice] } = await db.query(
      `SELECT referred_by_affiliate_id, referral_code_used, stripe_subscription_id 
       FROM practices WHERE id = $1`,
      [practiceId]
    );
    
    if (!practice?.referred_by_affiliate_id) {
      console.log(`Practice ${practiceId} was not referred by any affiliate - no commission created`);
      return;
    }
    
    // Get the affiliate's current tier based on their conversion count
    const tier = await getAffiliateTier(practice.referred_by_affiliate_id);
    
    console.log(`Affiliate ${practice.referred_by_affiliate_id} is in ${tier.name} tier (${tier.rate}%) with ${tier.referralCount} conversions`);
    
    // Get the pending referral record for this code (not yet linked to a practice)
    const { rows: [referral] } = await db.query(
      `SELECT id
       FROM affiliate_referrals
       WHERE referral_code = $1 AND practice_id IS NULL`,
      [practice.referral_code_used]
    );
    
    if (!referral) {
      console.log(`No pending referral record found for code: ${practice.referral_code_used}`);
      return;
    }
    
    // Update referral with practice_id, subscription_id, and conversion timestamp
    await db.query(
      `UPDATE affiliate_referrals 
       SET practice_id = $1, 
           converted_at = NOW(), 
           subscription_id = $2,
           first_payment_date = NOW()
       WHERE id = $3`,
      [practiceId, subscriptionId, referral.id]
    );
    
    // Calculate commission using dynamic tier rate (amount is in cents)
    const commissionAmount = (amount / 100) * (tier.rate / 100);
    
    // Set period start/end for this month
    const periodStart = new Date();
    periodStart.setDate(1);
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setDate(0);
    
    // Create commission record
    await db.query(
      `INSERT INTO affiliate_commissions (referral_id, amount, period_start, period_end, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [referral.id, commissionAmount, periodStart, periodEnd]
    );
    
    // Update affiliate earnings and conversion count
    await db.query(
      `UPDATE affiliates 
       SET total_conversions = total_conversions + 1,
           total_earnings = total_earnings + $1,
           pending_earnings = pending_earnings + $1
       WHERE id = $2`,
      [commissionAmount, practice.referred_by_affiliate_id]
    );
    
    // Update the tier column to match new conversion count
    await updateAffiliateTierColumn(practice.referred_by_affiliate_id);
    
    console.log(`✅ Created affiliate commission: $${commissionAmount.toFixed(2)} (${tier.rate}% ${tier.name} tier) for referral ${referral.id} (Practice: ${practiceId})`);
    
  } catch (error) {
    console.error('❌ Failed to create affiliate commission:', error);
  }
}

// Helper: Create recurring monthly commission
async function createRecurringAffiliateCommission(practiceId: number, invoice: Stripe.Invoice) {
  try {
    const { db } = await import('../db');
    
    // Get the affiliate tier for this practice
    const tierInfo = await getAffiliateTierByPractice(practiceId);
    
    if (!tierInfo) {
      console.log(`Practice ${practiceId} has no affiliate referral - no recurring commission`);
      return;
    }
    
    console.log(`Practice ${practiceId} referred by affiliate ${tierInfo.affiliateId} in ${tierInfo.name} tier (${tierInfo.rate}%) with ${tierInfo.referralCount} total conversions`);
    
    // Check if commission already created for this month
    const { rows: [existingCommission] } = await db.query(
      `SELECT c.id 
       FROM affiliate_commissions c
       JOIN affiliate_referrals r ON c.referral_id = r.id
       WHERE r.practice_id = $1 
       AND date_trunc('month', c.period_start) = date_trunc('month', NOW())`,
      [practiceId]
    );
    
    if (existingCommission) {
      console.log(`Commission already exists for practice ${practiceId} this month - skipping`);
      return;
    }
    
    const amount = invoice.amount_paid;
    const commissionAmount = (amount / 100) * (tierInfo.rate / 100);
    
    const periodStart = new Date();
    periodStart.setDate(1);
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    periodEnd.setDate(0);
    
    // Get the referral ID for this practice
    const { rows: [referral] } = await db.query(
      `SELECT id FROM affiliate_referrals 
       WHERE practice_id = $1`,
      [practiceId]
    );
    
    if (!referral) {
      console.log(`No referral found for practice ${practiceId}`);
      return;
    }
    
    // Update last_payment_date
    await db.query(
      `UPDATE affiliate_referrals 
       SET last_payment_date = NOW()
       WHERE id = $1`,
      [referral.id]
    );
    
    await db.query(
      `INSERT INTO affiliate_commissions (referral_id, amount, period_start, period_end, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [referral.id, commissionAmount, periodStart, periodEnd]
    );
    
    // Update affiliate earnings
    await db.query(
      `UPDATE affiliates 
       SET total_earnings = total_earnings + $1,
           pending_earnings = pending_earnings + $1
       WHERE id = $2`,
      [commissionAmount, tierInfo.affiliateId]
    );
    
    console.log(`✅ Created recurring commission: $${commissionAmount.toFixed(2)} (${tierInfo.rate}% ${tierInfo.name} tier) for practice ${practiceId}`);
    
  } catch (error) {
    console.error('❌ Failed to create recurring commission:', error);
  }
}

// Helper: Update practice subscription status
async function updatePracticeStatus(customerId: string, status: string, subscriptionId?: string) {
  try {
    const { db } = await import('../db');
    
    let query = `UPDATE practices SET subscription_status = $1`;
    const params: any[] = [status];
    
    if (subscriptionId) {
      query += `, stripe_subscription_id = $2`;
      params.push(subscriptionId);
      query += ` WHERE stripe_customer_id = $3`;
      params.push(customerId);
    } else {
      query += ` WHERE stripe_customer_id = $2`;
      params.push(customerId);
    }
    
    await db.query(query, params);
    console.log(`✅ Updated practice status to '${status}' for customer ${customerId}`);
    
  } catch (error) {
    console.error('❌ Failed to update practice status:', error);
  }
}

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
  
  console.log(`📨 Received webhook event: ${event.type}`);
  
  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object as Stripe.Checkout.Session;
      console.log(`✅ Checkout completed for session: ${session.id}`);
      console.log(`   UserId: ${session.metadata?.userId}`);
      console.log(`   PracticeId: ${session.metadata?.practiceId}`);
      console.log(`   Customer: ${session.customer}`);
      
      const amountTotal = session.amount_total;
      if (!amountTotal) {
        console.error('❌ No amount_total in checkout session');
        break;
      }
      
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
        
        await createAffiliateCommission(
          parseInt(session.metadata?.practiceId),
          session.subscription as string,
          amountTotal
        );
        
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
      }
      break;
      
    case 'invoice.payment_succeeded':
      const invoice = event.data.object as Stripe.Invoice;
      console.log(`💰 Payment succeeded for invoice: ${invoice.id}`);
      console.log(`   Customer: ${invoice.customer}`);
      console.log(`   Amount: $${(invoice.amount_paid / 100).toFixed(2)}`);
      
      if (invoice.subscription && invoice.customer) {
        try {
          const { db } = await import('../db');
          
          const { rows: [practice] } = await db.query(
            'SELECT id FROM practices WHERE stripe_customer_id = $1',
            [invoice.customer]
          );
          
          if (practice) {
            // Check if this practice has a converted referral
            const { rows: [existingReferral] } = await db.query(
              `SELECT id FROM affiliate_referrals 
               WHERE practice_id = $1`,
              [practice.id]
            );
            
            if (existingReferral) {
              await createRecurringAffiliateCommission(practice.id, invoice);
            } else {
              console.log(`Practice ${practice.id} has no referral yet - first payment will be handled by checkout.session.completed`);
            }
          }
        } catch (error) {
          console.error('❌ Failed to process recurring commission:', error);
        }
      }
      break;
      
    case 'customer.subscription.deleted':
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`❌ Subscription cancelled: ${subscription.id}`);
      try {
        await updatePracticeStatus(subscription.customer as string, 'cancelled');
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
      }
      break;
      
    case 'customer.subscription.updated':
      const updatedSubscription = event.data.object as Stripe.Subscription;
      console.log(`📝 Subscription updated: ${updatedSubscription.id}`);
      console.log(`   Status: ${updatedSubscription.status}`);
      
      if (updatedSubscription.status === 'past_due') {
        await updatePracticeStatus(updatedSubscription.customer as string, 'past_due');
      } else if (updatedSubscription.status === 'active') {
        await updatePracticeStatus(updatedSubscription.customer as string, 'active');
      }
      break;
      
    case 'invoice.payment_failed':
      const failedInvoice = event.data.object as Stripe.Invoice;
      console.log(`⚠️ Payment failed for invoice: ${failedInvoice.id}`);
      if (failedInvoice.customer) {
        await updatePracticeStatus(failedInvoice.customer as string, 'past_due');
      }
      break;
      
    default:
      console.log(`❓ Unhandled event type: ${event.type}`);
  }
  
  res.json({ received: true });
});

export default router;
