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

// Helper function to check if affiliate is approved
const checkAffiliateApproval = async (userId: string) => {
  const { rows: [affiliate] } = await db.query(
    'SELECT is_active, stripe_account_id FROM affiliates WHERE user_id = $1',
    [userId]
  );
  
  if (!affiliate) {
    throw new Error('Affiliate not found');
  }
  
  if (!affiliate.is_active) {
    throw new Error('Your affiliate account is pending admin approval. You will be notified once approved.');
  }
  
  return affiliate;
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
      'SELECT id, affiliate_code, is_active FROM affiliates WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${existing.rows[0].affiliate_code}`;
      
      // If existing affiliate is pending approval, inform them
      if (!existing.rows[0].is_active) {
        return res.json({
          success: true,
          alreadyExists: true,
          pendingApproval: true,
          affiliateCode: existing.rows[0].affiliate_code,
          affiliateLink,
          message: 'You are already registered but your account is pending admin approval.'
        });
      }
      
      return res.json({
        success: true,
        alreadyExists: true,
        pendingApproval: false,
        affiliateCode: existing.rows[0].affiliate_code,
        affiliateLink,
        message: 'You are already registered as an affiliate!'
      });
    }

    const affiliateCode = generateAffiliateCode(email);

    // Set is_active to false - requires admin approval
    const result = await db.query(
      `INSERT INTO affiliates (full_name, email, company_name, affiliate_code, payout_email, payout_method, is_active, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, NULL)
       RETURNING id, affiliate_code`,
      [fullName, email, companyName || null, affiliateCode, payoutEmail || null, payoutMethod || null]
    );

    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliateCode}`;

    res.json({
      success: true,
      affiliateCode: result.rows[0].affiliate_code,
      affiliateLink,
      message: 'Registration successful! Your account is pending admin approval.',
      pendingApproval: true
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
        maxAge: 90 * 24 * 60 * 60 * 1000,
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

router.get('/stats/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const affiliate = await db.query(
      `SELECT affiliate_code, total_clicks, total_signups, total_conversions, commission_rate, is_active
       FROM affiliates 
       WHERE affiliate_code = $1`,
      [code]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    if (!affiliate.rows[0].is_active) {
      return res.status(403).json({ error: 'Affiliate account pending approval' });
    }

    res.json(affiliate.rows[0]);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

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
         created_at,
         is_active
       FROM affiliates 
       WHERE affiliate_code = $1`,
      [code]
    );

    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    if (!affiliate.is_active) {
      return res.status(403).json({ error: 'Affiliate account pending approval' });
    }

    const AVG_SUBSCRIPTION_PRICE = 199;
    const estimatedEarnings = (affiliate.total_conversions || 0) * (affiliate.commission_rate / 100) * AVG_SUBSCRIPTION_PRICE;
    
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
    
    const { rows: [affiliate] } = await db.query(
      `SELECT id, affiliate_code, tier, commission_rate, total_clicks, total_signups, 
              total_conversions, total_earnings, pending_earnings, paid_earnings, 
              payout_email, payout_method, created_at, stripe_account_id, stripe_account_status, 
              auto_payout_enabled, is_active, approved_at
       FROM affiliates WHERE user_id = $1`,
      [userId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }
    
    if (!affiliate.is_active) {
      return res.json({
        pendingApproval: true,
        affiliate: {
          ...affiliate,
          message: 'Your account is pending admin approval.'
        },
        referrals: [],
        commissions: [],
        monthlyEarnings: []
      });
    }
    
    const { rows: referrals } = await db.query(
      `SELECT id, referral_code, status, clicked_at, signed_up_at, converted_at, practice_id
       FROM affiliate_referrals 
       WHERE affiliate_id = $1 
       ORDER BY clicked_at DESC 
       LIMIT 50`,
      [affiliate.id]
    );
    
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
      pendingApproval: false,
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
      'SELECT affiliate_code, is_active FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }
    
    if (!affiliate.is_active) {
      return res.status(403).json({ error: 'Account pending approval' });
    }
    
    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliate.affiliate_code}`;
    
    res.json({ affiliateLink });
  } catch (error) {
    console.error('Link error:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate link' });
  }
});

// ============================================
// STRIPE CONNECT ROUTES (with approval check)
// ============================================

router.post('/connect/setup', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    try {
      await checkAffiliateApproval(userId);
    } catch (error: any) {
      return res.status(403).json({ error: error.message });
    }
    
    const { rows: [affiliate] } = await db.query(
      'SELECT id, email, full_name, stripe_account_id, stripe_account_status FROM affiliates WHERE user_id = $1',
      [userId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate account not found' });
    }
    
    let stripeAccountId = affiliate.stripe_account_id;
    
    if (!stripeAccountId) {
      const account = await createConnectAccount(affiliate.id, affiliate.email, affiliate.full_name);
      stripeAccountId = account.id;
      
      await db.query(
        'UPDATE affiliates SET stripe_account_id = $1 WHERE id = $2',
        [stripeAccountId, affiliate.id]
      );
    }
    
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

router.get('/connect/status', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    try {
      await checkAffiliateApproval(userId);
    } catch (error: any) {
      return res.status(403).json({ error: error.message });
    }
    
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

router.post('/connect/login', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    
    try {
      await checkAffiliateApproval(userId);
    } catch (error: any) {
      return res.status(403).json({ error: error.message });
    }
    
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

router.post('/connect/auto-payout', authenticate, async (req: Request, res) => {
  try {
    const userId = req.user!.userId;
    const { enabled } = req.body;
    
    try {
      await checkAffiliateApproval(userId);
    } catch (error: any) {
      return res.status(403).json({ error: error.message });
    }
    
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

router.post('/admin/login', async (req: Request, res) => {
  const { email, password } = req.body;
  
  if (email === process.env.ADMIN_EMAIL && 
      password === process.env.ADMIN_PASSWORD) {
    
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: 'admin', email, isAdmin: true },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '8h' }
    );
    
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

router.get('/admin/pending', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { rows } = await db.query(
      `SELECT a.id, a.full_name, a.email, a.company_name, a.affiliate_code, 
              a.created_at, a.tier, a.commission_rate, a.payout_email, a.payout_method,
              a.total_clicks, a.total_signups
       FROM affiliates a
       WHERE a.is_active = false AND a.deleted_at IS NULL
       ORDER BY a.created_at ASC`,
      []
    );

    res.json({
      success: true,
      count: rows.length,
      affiliates: rows
    });
  } catch (error) {
    console.error('Failed to fetch pending affiliates:', error);
    res.status(500).json({ error: 'Failed to fetch pending affiliates' });
  }
});

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
       WHERE a.deleted_at IS NULL
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
      []
    );

    res.json({
      success: true,
      affiliates: rows
    });
  } catch (error) {
    console.error('Failed to fetch affiliates:', error);
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
});

router.put('/admin/:id/approve', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;
    const { commissionRate, tier } = req.body;

    const { rows: [affiliate] } = await db.query(
      'SELECT id, email, full_name, is_active FROM affiliates WHERE id = $1',
      [id]
    );

    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    if (affiliate.is_active) {
      return res.status(400).json({ error: 'Affiliate is already approved' });
    }

    await db.query(
      `UPDATE affiliates 
       SET is_active = true, 
           approved_at = NOW(),
           commission_rate = COALESCE($1, commission_rate, 20),
           tier = COALESCE($2, tier, 'standard')
       WHERE id = $3`,
      [commissionRate || 20, tier || 'standard', id]
    );

    await db.query(
      `INSERT INTO admin_actions (admin_id, action, target_id, target_type, details, created_at)
       VALUES ($1, 'approve_affiliate', $2, 'affiliate', $3, NOW())`,
      [req.user.userId, id, JSON.stringify({ commissionRate, tier })]
    );

    res.json({ 
      success: true, 
      message: 'Affiliate approved successfully',
      affiliate: { ...affiliate, is_active: true }
    });
  } catch (error) {
    console.error('Approve error:', error);
    res.status(500).json({ error: 'Failed to approve affiliate' });
  }
});

router.delete('/admin/:id/reject', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;

    const { rows: [affiliate] } = await db.query(
      'SELECT id, email FROM affiliates WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    await db.query(
      `UPDATE affiliates SET 
         deleted_at = NOW(), 
         is_active = false
       WHERE id = $1`,
      [id]
    );

    await db.query(
      `INSERT INTO admin_actions (admin_id, action, target_id, target_type, created_at)
       VALUES ($1, 'reject_affiliate', $2, 'affiliate', NOW())`,
      [req.user.userId, id]
    );

    res.json({ 
      success: true, 
      message: 'Affiliate rejected' 
    });
  } catch (error) {
    console.error('Reject error:', error);
    res.status(500).json({ error: 'Failed to reject affiliate' });
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
