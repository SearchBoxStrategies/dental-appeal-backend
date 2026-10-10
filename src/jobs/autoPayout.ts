import 'dotenv/config';
import { createHash } from 'crypto';
import { db } from '../db';
import { transferToAffiliate } from '../services/stripeConnect';

// Program terms: commissions are held 30 days, and payouts under $50 roll over to next month.
const HOLD_DAYS = 30;
const MIN_PAYOUT = 50;

interface Batch {
  ids: number[];
  amount: number;
}

// Same commissions -> same key, so a retried transfer is deduplicated by Stripe.
function payoutKey(affiliateId: number, ids: number[]) {
  const digest = createHash('sha256').update([...ids].sort((a, b) => a - b).join(',')).digest('hex').slice(0, 24);
  return `affiliate-payout-${affiliateId}-${digest}`;
}

// Atomically move eligible commissions from 'pending' to 'processing' so no other run can pay them.
async function claimCommissions(affiliateId: number): Promise<Batch> {
  const { rows } = await db.query(
    `UPDATE affiliate_commissions ac
     SET status = 'processing'
     WHERE ac.id IN (
       SELECT c.id
       FROM affiliate_commissions c
       JOIN affiliate_referrals r ON c.referral_id = r.id
       WHERE r.affiliate_id = $1
         AND c.status = 'pending'
         AND c.created_at <= NOW() - make_interval(days => $2)
       FOR UPDATE OF c SKIP LOCKED
     )
     RETURNING ac.id, ac.amount`,
    [affiliateId, HOLD_DAYS]
  );
  return {
    ids: rows.map(r => r.id),
    amount: Math.round(rows.reduce((sum, r) => sum + parseFloat(r.amount), 0) * 100) / 100,
  };
}

// Commissions left in 'processing' by a run that crashed mid-payout.
async function findStuckCommissions(affiliateId: number): Promise<Batch> {
  const { rows } = await db.query(
    `SELECT c.id, c.amount
     FROM affiliate_commissions c
     JOIN affiliate_referrals r ON c.referral_id = r.id
     WHERE r.affiliate_id = $1 AND c.status = 'processing'`,
    [affiliateId]
  );
  return {
    ids: rows.map(r => r.id),
    amount: Math.round(rows.reduce((sum, r) => sum + parseFloat(r.amount), 0) * 100) / 100,
  };
}

async function releaseCommissions(ids: number[]) {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE affiliate_commissions SET status = 'pending' WHERE id = ANY($1::int[]) AND status = 'processing'`,
    [ids]
  );
}

async function markPaid(affiliateId: number, batch: Batch, transferId: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE affiliate_commissions
       SET status = 'paid', paid_at = NOW(), stripe_transfer_id = $1
       WHERE id = ANY($2::int[]) AND status = 'processing'`,
      [transferId, batch.ids]
    );
    await client.query(
      `UPDATE affiliates
       SET pending_earnings = pending_earnings - $1,
           paid_earnings = paid_earnings + $1
       WHERE id = $2`,
      [batch.amount, affiliateId]
    );
    await client.query(
      `INSERT INTO payout_logs (affiliate_id, amount, status, stripe_transfer_id, processed_at)
       VALUES ($1, $2, 'success', $3, NOW())
       ON CONFLICT (stripe_transfer_id) DO NOTHING`,
      [affiliateId, batch.amount, transferId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function payBatch(affiliate: { id: number; stripe_account_id: string; email: string }, batch: Batch) {
  const transfer = await transferToAffiliate(
    affiliate.stripe_account_id,
    batch.amount,
    'usd',
    `Commission payout for ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}`,
    payoutKey(affiliate.id, batch.ids)
  );
  await markPaid(affiliate.id, batch, transfer.id);
  return transfer;
}

// Run this on a schedule (e.g., 15th of each month at 9am)
export async function processAutoPayouts() {
  console.log('🔄 Starting auto-payout process...');
  const startTime = Date.now();

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set in environment');
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY is not set in environment');
    return;
  }

  try {
    const { rows: affiliates } = await db.query(
      `SELECT id, stripe_account_id, email
       FROM affiliates
       WHERE stripe_account_id IS NOT NULL
       AND stripe_account_status = 'verified'
       AND auto_payout_enabled = true`
    );

    console.log(`💰 Checking ${affiliates.length} affiliates with verified payout accounts`);

    let successCount = 0;
    let failureCount = 0;
    let totalAmount = 0;

    for (const affiliate of affiliates) {
      // 1. Finish any payout a previous run started but didn't record. The payout key makes
      //    transferToAffiliate return the original transfer instead of sending money again.
      const stuck = await findStuckCommissions(affiliate.id);
      if (stuck.ids.length > 0) {
        try {
          const transfer = await payBatch(affiliate, stuck);
          console.log(`🔁 Recovered interrupted payout of $${stuck.amount.toFixed(2)} to ${affiliate.email} (Transfer: ${transfer.id})`);
          successCount++;
          totalAmount += stuck.amount;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`❌ Could not recover interrupted payout for affiliate ${affiliate.id} - leaving for manual review:`, errorMessage);
          failureCount++;
          continue;
        }
      }

      // 2. Claim commissions past the hold period, then pay them.
      const batch = await claimCommissions(affiliate.id);
      if (batch.ids.length === 0) continue;

      if (batch.amount < MIN_PAYOUT) {
        await releaseCommissions(batch.ids);
        console.log(`⏭️ Affiliate ${affiliate.id} (${affiliate.email}) has $${batch.amount.toFixed(2)} payable - below $${MIN_PAYOUT} minimum, rolling over`);
        continue;
      }

      try {
        const transfer = await payBatch(affiliate, batch);
        console.log(`✅ Paid $${batch.amount.toFixed(2)} to ${affiliate.email} (Transfer: ${transfer.id})`);
        successCount++;
        totalAmount += batch.amount;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`❌ Failed to payout affiliate ${affiliate.id} (${affiliate.email}):`, errorMessage);
        failureCount++;

        // Only release if Stripe definitely rejected the transfer. On network errors the
        // transfer may have gone through, so the batch stays 'processing' and step 1 of the
        // next run retries it with the same payout key.
        const stripeRejected = (error as any)?.type === 'StripeInvalidRequestError' || (error as any)?.type === 'StripeCardError';
        if (stripeRejected) await releaseCommissions(batch.ids);

        await db.query(
          `INSERT INTO payout_logs (affiliate_id, amount, status, error_message, processed_at)
           VALUES ($1, $2, 'failed', $3, NOW())`,
          [affiliate.id, batch.amount, errorMessage]
        );
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Auto-payout process completed in ${duration}s`);
    console.log(`📊 Summary: ${successCount} successful, ${failureCount} failed, total payout: $${totalAmount.toFixed(2)}`);

  } catch (error) {
    console.error('❌ Auto-payout process failed:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  processAutoPayouts().then(() => process.exit(0));
}
