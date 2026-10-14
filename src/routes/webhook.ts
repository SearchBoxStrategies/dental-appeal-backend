import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { PoolClient } from 'pg';
import { getAffiliateTier, getAffiliateTierByPractice, updateAffiliateTierColumn } from '../utils/affiliateTiers';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

const roundCents = (n: number) => Math.round(n * 100) / 100;

function currentPeriod() {
  const periodStart = new Date();
  periodStart.setDate(1);
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  periodEnd.setDate(0);
  return { periodStart, periodEnd };
}

// Inserts a pending commission keyed by Stripe invoice id. Returns false if this invoice
// already produced one (Stripe can deliver the same event more than once).
async function insertCommission(
  client: PoolClient,
  referralId: number,
  affiliateId: number,
  amount: number,
  stripeInvoiceId: string | null,
  period: { periodStart: Date; periodEnd: Date }
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO affiliate_commissions (referral_id, amount, period_start, period_end, status, stripe_invoice_id)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO NOTHING`,
    [referralId, amount, period.periodStart, period.periodEnd, stripeInvoiceId]
  );
  if (!rowCount) return false;

  await client.query(
    `UPDATE affiliates
     SET total_earnings = total_earnings + $1,
         pending_earnings = pending_earnings + $1
     WHERE id = $2`,
    [amount, affiliateId]
  );
  return true;
}

// Helper: Create affiliate commission on first payment
async function createAffiliateCommission(practiceId: number, subscriptionId: string, amount: number, stripeInvoiceId: string | null) {
  const { db } = await import('../db');
  const client = await db.connect();
  try {
    const { rows: [practice] } = await client.query(
      `SELECT referred_by_affiliate_id, referral_code_used, stripe_subscription_id
       FROM practices WHERE id = $1`,
      [practiceId]
    );

    if (!practice?.referred_by_affiliate_id) {
      console.log(`Practice ${practiceId} was not referred by any affiliate - no commission created`);
      return;
    }

    await client.query('BEGIN');

    const { rows: [referral] } = await client.query(
      `SELECT id
       FROM affiliate_referrals
       WHERE referral_code = $1 AND practice_id IS NULL
       LIMIT 1
       FOR UPDATE`,
      [practice.referral_code_used]
    );

    if (!referral) {
      await client.query('ROLLBACK');
      console.log(`No pending referral record found for code: ${practice.referral_code_used}`);
      return;
    }

    await client.query(
      `UPDATE affiliate_referrals
       SET practice_id = $1,
           status = 'converted',
           converted_at = NOW(),
           subscription_id = $2,
           first_payment_date = NOW()
       WHERE id = $3`,
      [practiceId, subscriptionId, referral.id]
    );
    await client.query(
      `UPDATE affiliates SET total_conversions = total_conversions + 1 WHERE id = $1`,
      [practice.referred_by_affiliate_id]
    );
    await client.query('COMMIT');

    // Tier is based on this month's conversions, including the one just recorded
    const tier = await getAffiliateTier(practice.referred_by_affiliate_id);
    const commissionAmount = roundCents((amount / 100) * (tier.rate / 100));

    await client.query('BEGIN');
    const created = await insertCommission(
      client, referral.id, practice.referred_by_affiliate_id, commissionAmount, stripeInvoiceId, currentPeriod()
    );
    await client.query('COMMIT');

    await updateAffiliateTierColumn(practice.referred_by_affiliate_id);

    if (created) {
      console.log(`✅ Created affiliate commission: $${commissionAmount.toFixed(2)} (${tier.rate}% ${tier.name} tier) for referral ${referral.id} (Practice: ${practiceId})`);
    } else {
      console.log(`Commission for invoice ${stripeInvoiceId} already exists - skipping`);
    }

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Failed to create affiliate commission:', error);
  } finally {
    client.release();
  }
}

// Helper: Create recurring monthly commission
async function createRecurringAffiliateCommission(practiceId: number, invoice: Stripe.Invoice) {
  const { db } = await import('../db');
  const client = await db.connect();
  try {
    if (!invoice.amount_paid) {
      console.log(`Invoice ${invoice.id} paid $0 - no commission`);
      return;
    }

    const tierInfo = await getAffiliateTierByPractice(practiceId);

    if (!tierInfo) {
      console.log(`Practice ${practiceId} has no affiliate referral - no recurring commission`);
      return;
    }

    console.log(`Practice ${practiceId} referred by affiliate ${tierInfo.affiliateId} in ${tierInfo.name} tier (${tierInfo.rate}%) with ${tierInfo.referralCount} conversions this month`);

    const { rows: [referral] } = await client.query(
      `SELECT id FROM affiliate_referrals
       WHERE practice_id = $1`,
      [practiceId]
    );

    if (!referral) {
      console.log(`No referral found for practice ${practiceId}`);
      return;
    }

    const commissionAmount = roundCents((invoice.amount_paid / 100) * (tierInfo.rate / 100));

    await client.query('BEGIN');
    await client.query(
      `UPDATE affiliate_referrals
       SET last_payment_date = NOW()
       WHERE id = $1`,
      [referral.id]
    );
    const created = await insertCommission(
      client, referral.id, tierInfo.affiliateId, commissionAmount, invoice.id, currentPeriod()
    );
    await client.query('COMMIT');

    if (created) {
      console.log(`✅ Created recurring commission: $${commissionAmount.toFixed(2)} (${tierInfo.rate}% ${tierInfo.name} tier) for practice ${practiceId}`);
    } else {
      console.log(`Commission for invoice ${invoice.id} already exists - skipping`);
    }

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Failed to create recurring commission:', error);
  } finally {
    client.release();
  }
}

// Records a subscription payment (positive) or refund (negative) against the practice that owns
// the Stripe customer. `ref` is unique per Stripe event source, so redelivered events are ignored.
// Returns true when a new row was written.
async function recordPayment(
  customerId: string,
  amount: number,
  ref: string,
  status: 'succeeded' | 'refunded'
): Promise<boolean> {
  const { db } = await import('../db');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [owner] } = await client.query(
      `SELECT p.id AS practice_id, u.id AS user_id, u.email, u.name
       FROM practices p
       JOIN users u ON u.practice_id = p.id AND COALESCE(u.user_type, 'clinic') <> 'affiliate'
       WHERE p.stripe_customer_id = $1
       ORDER BY u.created_at ASC
       LIMIT 1`,
      [customerId]
    );
    if (!owner) {
      await client.query('ROLLBACK');
      console.log(`No practice for Stripe customer ${customerId} - payment not recorded`);
      return false;
    }

    const { rowCount } = await client.query(
      `INSERT INTO payments (user_id, amount_paid, payment_method, status, stripe_payment_intent_id,
                             user_email, user_name, created_at)
       VALUES ($1, $2, 'card', $3, $4, $5, $6, NOW())
       ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL DO NOTHING`,
      [owner.user_id, amount, status, ref, owner.email, owner.name]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(
      `UPDATE practices
       SET total_paid = GREATEST(COALESCE(total_paid, 0) + $1::numeric, 0),
           last_payment_date = CASE WHEN $1::numeric > 0 THEN NOW() ELSE last_payment_date END,
           last_payment_amount = CASE WHEN $1::numeric > 0 THEN $1::numeric ELSE last_payment_amount END
       WHERE id = $2`,
      [amount, owner.practice_id]
    );
    await client.query('COMMIT');
    console.log(`💵 Recorded ${status} of $${amount.toFixed(2)} for practice ${owner.practice_id}`);
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Refunds: charge.amount_refunded is cumulative, so record only the part not yet recorded.
async function recordRefund(charge: Stripe.Charge) {
  const customerId = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
  if (!customerId || !charge.amount_refunded) return;
  const { db } = await import('../db');
  const { rows: [prior] } = await db.query(
    `SELECT COALESCE(-SUM(amount_paid), 0) AS refunded FROM payments WHERE stripe_payment_intent_id LIKE $1`,
    [`refund:${charge.id}:%`]
  );
  const delta = roundCents(charge.amount_refunded / 100 - parseFloat(prior.refunded));
  if (delta <= 0) return;
  await recordPayment(customerId, -delta, `refund:${charge.id}:${charge.amount_refunded}`, 'refunded');
}

// Helper: Claw back commission when a subscription payment is refunded.
// Adds a negative pending commission that nets against the affiliate's next payout.
async function reverseCommissionForRefund(charge: Stripe.Charge) {
  const invoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id;
  if (!invoiceId || !charge.amount) return;

  const { db } = await import('../db');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [commission] } = await client.query(
      `SELECT c.id, c.amount, c.referral_id, c.period_start, c.period_end, r.affiliate_id
       FROM affiliate_commissions c
       JOIN affiliate_referrals r ON c.referral_id = r.id
       WHERE c.stripe_invoice_id = $1
       FOR UPDATE OF c`,
      [invoiceId]
    );

    if (!commission) {
      await client.query('ROLLBACK');
      console.log(`Refund on invoice ${invoiceId} has no affiliate commission - nothing to reverse`);
      return;
    }

    // charge.amount_refunded is cumulative, so reverse only what hasn't been reversed yet
    const target = roundCents(parseFloat(commission.amount) * (charge.amount_refunded / charge.amount));
    const { rows: [prior] } = await client.query(
      `SELECT COALESCE(-SUM(amount), 0) AS reversed
       FROM affiliate_commissions
       WHERE stripe_invoice_id LIKE $1`,
      [`refund:${charge.id}:%`]
    );
    const delta = roundCents(target - parseFloat(prior.reversed));

    if (delta <= 0) {
      await client.query('ROLLBACK');
      return;
    }

    const created = await insertCommission(
      client,
      commission.referral_id,
      commission.affiliate_id,
      -delta,
      `refund:${charge.id}:${charge.amount_refunded}`,
      { periodStart: commission.period_start, periodEnd: commission.period_end }
    );
    await client.query('COMMIT');

    if (created) {
      console.log(`↩️ Reversed $${delta.toFixed(2)} commission for refunded invoice ${invoiceId} (affiliate ${commission.affiliate_id})`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Failed to reverse commission for refund:', error);
  } finally {
    client.release();
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

router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
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
  
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log(`✅ Checkout completed for session: ${session.id}`);
      console.log(`   UserId: ${session.metadata?.userId}`);
      console.log(`   PracticeId: ${session.metadata?.practiceId}`);
      console.log(`   ReferralCode: ${session.metadata?.referralCode}`);
      console.log(`   Customer: ${session.customer}`);
      
      const amountTotal = session.amount_total;
      if (!amountTotal) {
        console.error('❌ No amount_total in checkout session');
        break;
      }
      
      try {
        const { db } = await import('../db');
        
        const referralCode = session.metadata?.referralCode;
        const practiceId = session.metadata?.practiceId;
        
        if (referralCode && practiceId) {
          await db.query(
            `UPDATE practices 
             SET referral_code_used = $1,
                 referred_by_affiliate_id = (
                   SELECT affiliate_id FROM affiliate_referrals 
                   WHERE referral_code = $3 LIMIT 1
                 )
             WHERE id = $2`,
            // Same value passed twice: reusing $1 for both the column and the comparison makes
            // Postgres reject the query, which aborted this whole webhook (practice never activated).
            [referralCode, practiceId, referralCode]
          );
          console.log(`✅ Updated practice ${practiceId} with referral code ${referralCode}`);
        }
        
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
          amountTotal,
          typeof session.invoice === 'string' ? session.invoice : session.invoice?.id ?? null
        );
        
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
      }
      break;
    }
      
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      console.log(`💰 Payment succeeded for invoice: ${invoice.id}`);
      console.log(`   Customer: ${invoice.customer}`);
      console.log(`   Amount: $${(invoice.amount_paid / 100).toFixed(2)}`);
      
      // Revenue: every paid invoice, the first one included.
      if (invoice.customer && invoice.amount_paid > 0) {
        try {
          await recordPayment(
            typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id,
            roundCents(invoice.amount_paid / 100),
            invoice.id,
            'succeeded'
          );
        } catch (error) {
          console.error('❌ Failed to record payment:', error);
        }
      }

      if (invoice.subscription && invoice.customer) {
        try {
          const { db } = await import('../db');
          
          const { rows: [practice] } = await db.query(
            'SELECT id FROM practices WHERE stripe_customer_id = $1',
            [invoice.customer]
          );
          
          if (practice) {
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
    }
      
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`❌ Subscription cancelled: ${subscription.id}`);
      try {
        await updatePracticeStatus(subscription.customer as string, 'cancelled');
      } catch (dbError) {
        console.error('❌ Database update failed:', dbError);
      }
      break;
    }
      
    case 'customer.subscription.updated': {
      const updatedSubscription = event.data.object as Stripe.Subscription;
      console.log(`📝 Subscription updated: ${updatedSubscription.id}`);
      console.log(`   Status: ${updatedSubscription.status}`);
      
      if (updatedSubscription.status === 'past_due') {
        await updatePracticeStatus(updatedSubscription.customer as string, 'past_due');
      } else if (updatedSubscription.status === 'active') {
        await updatePracticeStatus(updatedSubscription.customer as string, 'active');
      }
      break;
    }
      
    case 'invoice.payment_failed': {
      const failedInvoice = event.data.object as Stripe.Invoice;
      console.log(`⚠️ Payment failed for invoice: ${failedInvoice.id}`);
      if (failedInvoice.customer) {
        await updatePracticeStatus(failedInvoice.customer as string, 'past_due');
      }
      break;
    }
    
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      console.log(`↩️ Charge refunded: ${charge.id} ($${(charge.amount_refunded / 100).toFixed(2)} of $${(charge.amount / 100).toFixed(2)})`);
      await reverseCommissionForRefund(charge);
      try {
        await recordRefund(charge);
      } catch (error) {
        console.error('❌ Failed to record refund:', error);
      }
      break;
    }

    case 'account.updated': {
      const account = event.data.object as Stripe.Account;
      const affiliateId = account.metadata?.affiliateId;
      
      if (affiliateId) {
        const { db } = await import('../db');
        const isActive = account.charges_enabled && account.payouts_enabled;
        
        await db.query(
          `UPDATE affiliates 
           SET stripe_account_status = $1,
               auto_payout_enabled = CASE WHEN $2 AND stripe_onboarded_at IS NULL THEN true ELSE auto_payout_enabled END,
               stripe_onboarded_at = CASE WHEN $2 AND stripe_onboarded_at IS NULL THEN NOW() ELSE stripe_onboarded_at END
           WHERE id = $3`,
          [isActive ? 'verified' : 'pending', isActive, affiliateId]
        );
        
        console.log(`✅ Updated affiliate ${affiliateId} Connect status to ${isActive ? 'verified' : 'pending'}`);
      }
      break;
    }
      
    default:
      console.log(`❓ Unhandled event type: ${event.type}`);
  }
  
  res.json({ received: true });
});

export default router;
