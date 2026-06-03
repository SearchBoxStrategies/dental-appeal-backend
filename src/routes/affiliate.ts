import { Router, Request } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import crypto from 'crypto';
import { createConnectAccount, createAccountOnboardingLink, createAccountLoginLink, getAccountStatus } from '../services/stripeConnect';

const router = Router();

const generateAffiliateCode = (email: string): string => {
  const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${random}`;
};

// ============================================
// PUBLIC ROUTES
// ============================================

router.post('/signup', async (req, res) => {
  const { fullName, email, companyName, payoutEmail, payoutMethod } = req.body;

  if (!fullName || !email) {
    return res.status(400).json({ error: 'Full name and email are required' });
  }

  try {
    const existing = await db.query(
      'SELECT id, affiliate_code FROM affiliates WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${existing.rows[0].affiliate_code}`;
      return res.json({
        success: true,
        alreadyExists: true,
        affiliateCode: existing.rows[0].affiliate_code,
        affiliateLink,
        message: 'You are already registered as an affiliate!'
      });
    }

    const affiliateCode = generateAffiliateCode(email);

    const result = await db.query(
      `INSERT INTO affiliates (full_name, email, company_name, affiliate_code, payout_email, payout_method, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, affiliate_code`,
      [fullName, email, companyName || null, affiliateCode, payoutEmail || null, payoutMethod || null]
    );

    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliateCode}`;

    res.json({
      success: true,
      affiliateCode: result.rows[0].affiliate_code,
      affiliateLink,
      message: 'Affiliate registration successful!'
    });
  } catch (error) {
    console.error('Affiliate signup error:', error);
    res.status(500).json({ error: 'Failed to register affiliate' });
  }
});

router.get('/track/:code', async (req, res) => {
  const { code } = req.params;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  try {
    const affiliate = await db.query(
      'SELECT id FROM affiliates WHERE affiliate_code = $1 AND is_active = true',
      [code]
    );

    if (affiliate.rows.length > 0) {
      await db.query(
        `INSERT INTO affiliate_referrals (affiliate_id, referral_code, click_ip, click_user_agent, status)
         VALUES ($1, $2, $3, $4, 'clicked')`,
        [affiliate.rows[0].id, code, ip, userAgent]
      );

      await db.query(
        'UPDATE affiliates SET total_clicks = total_clicks + 1 WHERE id = $1',
        [affiliate.rows[0].id]
      );

      // Set 90-day cookie for attribution
      res.cookie('affiliate_ref', code, {
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/'
      });
    }

    res.redirect(`${process.env.FRONTEND_URL}/register?ref=${code}`);
  } catch (error) {
    console.error('Track error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/register`);
  }
});

// Basic stats endpoint (public, limited data)
router.get('/stats/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const affiliate = await db.query(
      `SELECT affiliate_code, total_clicks, total_signups, total_conversions, commission_rate
       FROM affiliates 
       WHERE affiliate_code = $1 AND is_active = true`,
      [code]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    res.json(affiliate.rows[0]);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// PUBLIC STATS PAGE ROUTE
// ============================================

router.get('/public-stats/:code', async (req, res) => {
  try {
    const { code } = req.params;
    
    const { rows: [affiliate] } = await db.query(
      `SELECT 
         affiliate_code,
         full_name,
         total_clicks,
         total_signups,
         total_conversions,
         commission_rate,
         tier,
         created_at
       FROM affiliates 
       WHERE affiliate_code = $1 AND is_active = true`,
      [code]
    );

    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    // Calculate estimated earnings (total_conversions * commission_rate * average subscription value)
    // Assuming $199/month per converted practice
    const AVG_SUBSCRIPTION_PRICE = 199;
    const estimatedEarnings = (affiliate.total_conversions || 0) * (affiliate.commission_rate / 100) * AVG_SUBSCRIPTION_PRICE;
    
    // Format dates
    const memberSince = new Date(affiliate.created_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long'
    });

    res.json({
      success: true,
      data: {
        code: affiliate.affiliate_code,
        name: affiliate.full_name,
        memberSince: memberSince,
        clicks: affiliate.total_clicks || 0,
        signups: affiliate.total_signups || 0,
        conversions: affiliate.total_conversions || 0,
        commissionRate: affiliate.commission_rate || 20,
        tier: affiliate.tier || 'standard',
        estimatedEarnings: Math.round(estimatedEarnings),
        joinLink: `${process.env.FRONTEND_URL}/register?ref=${affiliate.affiliate_code}`
      }
    });
  } catch (error) {
    console.error('Public stats error:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate stats' });
  }
});

// ============================================
// AFFILIATE DASHBOARD ROUTES (Authenticated)
// ============================================

router.get('/dashboard', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    // Get affiliate info
    const { rows: [affiliate] } = await db.query(
      `SELECT id, affiliate_code, tier, commission_rate, total_clicks, total_signups, 
              total_conversions, total_earnings, pending_earnings, paid_earnings, 
              payout_email, payout_method, created_at, stripe_account_id, stripe_account_status, auto_payout_enabled
       FROM affiliates WHERE user_id = $1`,
      [userId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }
    
    // Get recent referrals
    const { rows: referrals } = await db.query(
      `SELECT id, referral_code, status, clicked_at, signed_up_at, converted_at, practice_id
       FROM affiliate_referrals 
       WHERE affiliate_id = $1 
       ORDER BY clicked_at DESC 
       LIMIT 50`,
      [affiliate.id]
    );
    
    // Get recent commissions
    const { rows: commissions } = await db.query(
      `SELECT ac.id, ac.amount, ac.period_start, ac.period_end, ac.status, ac.paid_at, ac.created_at,
              p.name as practice_name
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       LEFT JOIN practices p ON ar.practice_id = p.id
       WHERE ar.affiliate_id = $1 
       ORDER BY ac.created_at DESC 
       LIMIT 50`,
      [affiliate.id]
    );
    
    // Get monthly earnings summary
    const { rows: monthlyEarnings } = await db.query(
      `SELECT DATE_TRUNC('month', ac.created_at) as month, 
              SUM(ac.amount) as total,
              COUNT(ac.id) as commission_count
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       WHERE ar.affiliate_id = $1 AND ac.status = 'paid'
       GROUP BY DATE_TRUNC('month', ac.created_at)
       ORDER BY month DESC
       LIMIT 12`,
      [affiliate.id]
    );
    
    res.json({
      affiliate,
      referrals,
      commissions,
      monthlyEarnings
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

router.get('/link', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    const { rows: [affiliate] } = await db.query(
      'SELECT affiliate_code FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }
    
    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliate.affiliate_code}`;
    
    res.json({ affiliateLink });
  } catch (error) {
    console.error('Link error:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate link' });
  }
});

// ============================================
// STRIPE CONNECT ROUTES
// ============================================

// Create or get Stripe Connect account for affiliate
router.post('/connect/setup', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    // Get affiliate by user_id
    const { rows: [affiliate] } = await db.query(
      'SELECT id, email, full_name, stripe_account_id, stripe_account_status FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate account not found' });
    }
    
    let stripeAccountId = affiliate.stripe_account_id;
    
    // If no Stripe account exists, create one
    if (!stripeAccountId) {
      const account = await createConnectAccount(affiliate.id, affiliate.email, affiliate.full_name);
      stripeAccountId = account.id;
      
      await db.query(
        'UPDATE affiliates SET stripe_account_id = $1 WHERE id = $2',
        [stripeAccountId, affiliate.id]
      );
    }
    
    // Create onboarding link
    const accountLink = await createAccountOnboardingLink(stripeAccountId);
    
    res.json({
      success: true,
      url: accountLink.url,
      accountStatus: affiliate.stripe_account_status,
    });
  } catch (error) {
    console.error('Connect setup error:', error);
    res.status(500).json({ error: 'Failed to setup Stripe Connect' });
  }
});

// Get Connect account status
router.get('/connect/status', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    const { rows: [affiliate] } = await db.query(
      'SELECT stripe_account_id, stripe_account_status, auto_payout_enabled FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate || !affiliate.stripe_account_id) {
      return res.json({ hasAccount: false, status: null });
    }
    
    const status = await getAccountStatus(affiliate.stripe_account_id);
    
    res.json({
      hasAccount: true,
      status: affiliate.stripe_account_status,
      details_submitted: status?.details_submitted,
      payouts_enabled: status?.payouts_enabled,
      auto_payout_enabled: affiliate.auto_payout_enabled,
    });
  } catch (error) {
    console.error('Connect status error:', error);
    res.status(500).json({ error: 'Failed to get Connect status' });
  }
});

// Create login link for affiliate to manage their Stripe account
router.post('/connect/login', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    const { rows: [affiliate] } = await db.query(
      'SELECT stripe_account_id FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate?.stripe_account_id) {
      return res.status(404).json({ error: 'No Stripe account found' });
    }
    
    const loginLink = await createAccountLoginLink(affiliate.stripe_account_id);
    
    res.json({ url: loginLink.url });
  } catch (error) {
    console.error('Connect login error:', error);
    res.status(500).json({ error: 'Failed to create login link' });
  }
});

// Toggle auto-payout (affiliate can enable/disable)
router.post('/connect/auto-payout', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    const { enabled } = req.body;
    
    const { rows: [affiliate] } = await db.query(
      'SELECT stripe_account_id FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate?.stripe_account_id) {
      return res.status(404).json({ error: 'No Stripe account found' });
    }
    
    await db.query(
      'UPDATE affiliates SET auto_payout_enabled = $1 WHERE user_id = $2',
      [enabled, userId]
    );
    
    res.json({ success: true, auto_payout_enabled: enabled });
  } catch (error) {
    console.error('Toggle auto-payout error:', error);
    res.status(500).json({ error: 'Failed to update auto-payout setting' });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

router.get('/admin/list', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { rows } = await db.query(
      `SELECT a.*, 
              COUNT(ar.id) as total_referrals,
              SUM(CASE WHEN ar.status = 'converted' THEN 1 ELSE 0 END) as total_converted
       FROM affiliates a
       LEFT JOIN affiliate_referrals ar ON a.id = ar.affiliate_id
       GROUP BY a.id
       ORDER BY a.created_at DESC`
    );

    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch affiliates:', error);
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
});

router.get('/admin/commissions', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { rows } = await db.query(
      `SELECT ac.*, a.full_name as affiliate_name, p.name as practice_name
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       JOIN affiliates a ON ar.affiliate_id = a.id
       LEFT JOIN practices p ON ar.practice_id = p.id
       ORDER BY ac.created_at DESC
       LIMIT 200`
    );

    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch commissions:', error);
    res.status(500).json({ error: 'Failed to fetch commissions' });
  }
});

router.put('/admin/:id/approve', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;
    const { commissionRate, tier } = req.body;

    await db.query(
      `UPDATE affiliates 
       SET is_active = true, 
           approved_at = NOW(),
           commission_rate = COALESCE($1, commission_rate),
           tier = COALESCE($2, tier)
       WHERE id = $3`,
      [commissionRate, tier, id]
    );

    res.json({ success: true, message: 'Affiliate approved successfully' });
  } catch (error) {
    console.error('Approve error:', error);
    res.status(500).json({ error: 'Failed to approve affiliate' });
  }
});

// Manual payout endpoint (kept for admin override)
router.post('/admin/:id/payout', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;

    const pendingCommissions = await db.query(
      `SELECT ac.id, ac.amount
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       WHERE ar.affiliate_id = $1 AND ac.status = 'pending'`,
      [id]
    );

    if (pendingCommissions.rows.length === 0) {
      return res.json({ message: 'No pending commissions to mark as paid' });
    }

    const totalAmount = pendingCommissions.rows.reduce((sum, c) => sum + parseFloat(c.amount), 0);
    const ids = pendingCommissions.rows.map(c => c.id);

    await db.query(
      `UPDATE affiliate_commissions 
       SET status = 'paid', paid_at = NOW()
       WHERE id = ANY($1::int[])`,
      [ids]
    );

    await db.query(
      `UPDATE affiliates 
       SET pending_earnings = 0,
           paid_earnings = paid_earnings + $1
       WHERE id = $2`,
      [totalAmount, id]
    );

    res.json({ 
      success: true, 
      message: `Marked ${pendingCommissions.rows.length} commissions as paid for $${totalAmount.toFixed(2)}`
    });
  } catch (error) {
    console.error('Payout error:', error);
    res.status(500).json({ error: 'Failed to process payout' });
  }
});

export default router;
