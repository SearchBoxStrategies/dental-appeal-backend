import 'dotenv/config';
import { db } from '../db';
import { transferToAffiliate } from '../services/stripeConnect';

// Run this on a schedule (e.g., 15th of each month at 9am)
export async function processAutoPayouts() {
  console.log('🔄 Starting auto-payout process...');
  
  // Verify environment variables are loaded
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set in environment');
    return;
  }
  
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ STRIPE_SECRET_KEY is not set in environment');
    return;
  }
  
  try {
    // Get all affiliates with verified Stripe accounts and auto-payout enabled
    const { rows: affiliates } = await db.query(
      `SELECT id, stripe_account_id, pending_earnings
       FROM affiliates 
       WHERE stripe_account_id IS NOT NULL 
       AND stripe_account_status = 'verified'
       AND auto_payout_enabled = true
       AND pending_earnings > 0`
    );
    
    console.log(`Found ${affiliates.length} affiliates with pending earnings`);
    
    for (const affiliate of affiliates) {
      try {
        const amount = parseFloat(affiliate.pending_earnings);
        
        if (amount < 1) {
          console.log(`Skipping affiliate ${affiliate.id} - pending earnings less than $1`);
          continue;
        }
        
        // Transfer funds via Stripe Connect
        const transfer = await transferToAffiliate(
          affiliate.stripe_account_id,
          amount,
          'usd',
          `Monthly commission payout for ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}`
        );
        
        // Get all pending commissions for this affiliate
        const { rows: pendingCommissions } = await db.query(
          `SELECT ac.id
           FROM affiliate_commissions ac
           JOIN affiliate_referrals ar ON ac.referral_id = ar.id
           WHERE ar.affiliate_id = $1 AND ac.status = 'pending'`,
          [affiliate.id]
        );
        
        const commissionIds = pendingCommissions.map(c => c.id);
        
        if (commissionIds.length > 0) {
          // Mark commissions as paid
          await db.query(
            `UPDATE affiliate_commissions 
             SET status = 'paid', 
                 paid_at = NOW(),
                 stripe_transfer_id = $1
             WHERE id = ANY($2::int[])`,
            [transfer.id, commissionIds]
          );
          
          // Update affiliate earnings
          await db.query(
            `UPDATE affiliates 
             SET pending_earnings = 0,
                 paid_earnings = paid_earnings + $1
             WHERE id = $2`,
            [amount, affiliate.id]
          );
          
          console.log(`✅ Paid $${amount.toFixed(2)} to affiliate ${affiliate.id} (Transfer: ${transfer.id})`);
        }
        
      } catch (error) {
        console.error(`❌ Failed to payout affiliate ${affiliate.id}:`, error);
        // Continue with next affiliate
      }
    }
    
    console.log('✅ Auto-payout process completed');
  } catch (error) {
    console.error('❌ Auto-payout process failed:', error);
  }
}

// Run if called directly
if (require.main === module) {
  processAutoPayouts().then(() => process.exit(0));
}
