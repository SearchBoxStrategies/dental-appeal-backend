import 'dotenv/config';
import { db } from '../db';
import { updateAffiliateTierColumn } from '../utils/affiliateTiers';

// Program terms: US$50 when a referred clinic's first payment has cleared the 30-day hold, and US$50 each
// when it is still paying at month 6 and at month 12. Bonuses are commission rows (kind != 'commission'),
// so they follow the same payout rules as commissions: monthly on the 15th, US$50 minimum.
const BONUS_AMOUNT = 50;
const HOLD_DAYS = 30;

const MILESTONES = [
  { kind: 'signon_bonus', key: 'signon', addDays: HOLD_DAYS, addMonths: 0 },
  { kind: 'loyalty_6', key: 'm6', addDays: 0, addMonths: 6 },
  { kind: 'loyalty_12', key: 'm12', addDays: 0, addMonths: 12 },
] as const;

// Referred clinics that are paying now, with the first payment date the bonus clocks run from.
async function eligibleReferrals() {
  const { rows } = await db.query(
    `SELECT ar.id AS referral_id, ar.affiliate_id,
            COALESCE(ar.first_payment_date, ar.converted_at) AS started_at
     FROM affiliate_referrals ar
     JOIN affiliates a ON a.id = ar.affiliate_id AND a.is_active = true AND a.deleted_at IS NULL
     JOIN practices p ON p.id = ar.practice_id
     WHERE ar.converted_at IS NOT NULL
       AND p.subscription_status = 'active'
       AND p.deleted_at IS NULL
       AND COALESCE(p.total_paid, 0) > 0`
  );
  return rows as { referral_id: number; affiliate_id: number; started_at: Date }[];
}

function milestoneDate(start: Date, addDays: number, addMonths: number): Date {
  const d = new Date(start);
  if (addMonths) d.setUTCMonth(d.getUTCMonth() + addMonths);
  if (addDays) d.setUTCDate(d.getUTCDate() + addDays);
  return d;
}

// Creates any bonuses that have come due. Safe to run any number of times: each bonus has a unique key.
export async function awardAffiliateBonuses(now: Date = new Date()): Promise<{ awarded: number }> {
  let awarded = 0;
  for (const r of await eligibleReferrals()) {
    for (const m of MILESTONES) {
      const due = milestoneDate(new Date(r.started_at), m.addDays, m.addMonths);
      if (due > now) continue;

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        // Dated at the milestone, so it is payable at the next payout without a second hold.
        const { rowCount } = await client.query(
          `INSERT INTO affiliate_commissions
             (referral_id, amount, period_start, period_end, status, stripe_invoice_id, kind, created_at)
           VALUES ($1, $2, $3::timestamptz::date, $3::timestamptz::date, 'pending', $4, $5, $3::timestamptz)
           ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO NOTHING`,
          [r.referral_id, BONUS_AMOUNT, due, `bonus:${m.key}:${r.referral_id}`, m.kind]
        );
        if (rowCount) {
          await client.query(
            `UPDATE affiliates
             SET total_earnings = total_earnings + $1, pending_earnings = pending_earnings + $1
             WHERE id = $2`,
            [BONUS_AMOUNT, r.affiliate_id]
          );
          awarded++;
          console.log(`🎁 ${m.kind} $${BONUS_AMOUNT} for referral ${r.referral_id} (affiliate ${r.affiliate_id})`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ Failed to award affiliate bonus:', error);
      } finally {
        client.release();
      }
    }
  }
  return { awarded };
}

// Tiers follow active clinics, which change when clinics cancel, so refresh them every day too.
export async function refreshAllTiers() {
  const { rows } = await db.query(`SELECT id FROM affiliates WHERE is_active = true AND deleted_at IS NULL`);
  for (const a of rows) await updateAffiliateTierColumn(a.id);
}

// Once a day (UTC); the job_runs row makes it happen once across restarts and instances.
export async function runDailyAffiliateJobsIfDue(now: Date = new Date()): Promise<boolean> {
  const period = now.toISOString().slice(0, 10);
  const { rows } = await db.query(
    `INSERT INTO job_runs (job, period) VALUES ('affiliate-bonuses', $1)
     ON CONFLICT (job, period) DO NOTHING RETURNING job`,
    [period]
  );
  if (rows.length === 0) return false;
  console.log(`📅 Daily affiliate bonuses and tiers for ${period}`);
  await awardAffiliateBonuses(now);
  await refreshAllTiers();
  return true;
}

export function scheduleAffiliateBonuses() {
  if (process.env.AUTO_PAYOUTS === 'off') return;
  const tick = () => runDailyAffiliateJobsIfDue().catch((err) => console.error('Daily affiliate jobs failed:', err));
  setTimeout(tick, 3 * 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
