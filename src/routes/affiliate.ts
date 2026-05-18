import { Router } from 'express';
import { db } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

// Generate unique affiliate code from email
const generateAffiliateCode = (email: string): string => {
  const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${random}`;
};

// ============================================
// PUBLIC ROUTES (No authentication required)
// ============================================

// POST /api/affiliate/signup - Affiliate registration from landing page
router.post('/signup', async (req, res) => {
  const { fullName, email, companyName, payoutEmail, payoutMethod } = req.body;

  // Validation
  if (!fullName || !email) {
    return res.status(400).json({ error: 'Full name and email are required' });
  }

  try {
    // Check if affiliate already exists
    const existing = await db.query(
      'SELECT id, affiliate_code FROM affiliates WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      // Return existing affiliate info
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
       RETURNING id, affiliate_code, created_at`,
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

// GET /api/affiliate/track/:code - Track affiliate click (redirects to registration)
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
      // Record the click
      await db.query(
        `INSERT INTO affiliate_referrals (affiliate_id, referral_code, click_ip, click_user_agent, status)
         VALUES ($1, $2, $3, $4, 'clicked')`,
        [affiliate.rows[0].id, code, ip, userAgent]
      );

      // Update click count
      await db.query(
        'UPDATE affiliates SET total_clicks = total_clicks + 1 WHERE id = $1',
        [affiliate.rows[0].id]
      );
      
      console.log(`📊 Affiliate click tracked: ${code} from ${ip}`);
    } else {
      console.log(`⚠️ Invalid affiliate code clicked: ${code}`);
    }

    // Redirect to registration page with ref param
    res.redirect(`${process.env.FRONTEND_URL}/register?ref=${code}`);
  } catch (error) {
    console.error('Track error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/register`);
  }
});

// GET /api/affiliate/stats/:code - Get public stats for an affiliate link
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
// AUTHENTICATED ROUTES (Require login)
// ============================================

// GET /api/affiliate/dashboard - Get affiliate dashboard data
router.get('/dashboard', authenticate, async (req: AuthRequest, res) => {
  try {
    const userEmail = req.user!.email;

    const affiliate = await db.query(
      `SELECT id, affiliate_code, tier, commission_rate, total_clicks, total_signups, 
              total_conversions, total_earnings, pending_earnings, paid_earnings, payout_email,
              created_at
       FROM affiliates 
       WHERE email = $1`,
      [userEmail]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found. Please sign up first.' });
    }

    const affiliateId = affiliate.rows[0].id;

    // Get recent referrals
    const referrals = await db.query(
      `SELECT ar.*, p.name as practice_name, p.subscription_status
       FROM affiliate_referrals ar
       LEFT JOIN practices p ON ar.practice_id = p.id
       WHERE ar.affiliate_id = $1
       ORDER BY ar.clicked_at DESC
       LIMIT 50`,
      [affiliateId]
    );

    // Get recent commissions
    const commissions = await db.query(
      `SELECT ac.*, ar.referral_code, p.name as practice_name
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       LEFT JOIN practices p ON ar.practice_id = p.id
       WHERE ar.affiliate_id = $1
       ORDER BY ac.created_at DESC
       LIMIT 20`,
      [affiliateId]
    );

    // Get monthly earnings summary
    const monthlyEarnings = await db.query(
      `SELECT 
         TO_CHAR(period_start, 'YYYY-MM') as month,
         SUM(amount) as total,
         COUNT(*) as commission_count
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       WHERE ar.affiliate_id = $1
       GROUP BY TO_CHAR(period_start, 'YYYY-MM')
       ORDER BY month DESC
       LIMIT 12`,
      [affiliateId]
    );

    res.json({
      affiliate: affiliate.rows[0],
      referrals: referrals.rows,
      commissions: commissions.rows,
      monthlyEarnings: monthlyEarnings.rows
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// GET /api/affiliate/link - Get affiliate referral link
router.get('/link', authenticate, async (req: AuthRequest, res) => {
  try {
    const userEmail = req.user!.email;

    const affiliate = await db.query(
      'SELECT affiliate_code FROM affiliates WHERE email = $1',
      [userEmail]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliate.rows[0].affiliate_code}`;
    res.json({ affiliateLink });
  } catch (error) {
    console.error('Link generation error:', error);
    res.status(500).json({ error: 'Failed to generate affiliate link' });
  }
});

// GET /api/affiliate/earnings - Get earnings summary
router.get('/earnings', authenticate, async (req: AuthRequest, res) => {
  try {
    const userEmail = req.user!.email;

    const affiliate = await db.query(
      'SELECT id FROM affiliates WHERE email = $1',
      [userEmail]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    const affiliateId = affiliate.rows[0].id;

    const earnings = await db.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid,
         COALESCE(SUM(amount), 0) as total
       FROM affiliate_commissions ac
       JOIN affiliate_referrals ar ON ac.referral_id = ar.id
       WHERE ar.affiliate_id = $1`,
      [affiliateId]
    );

    res.json(earnings.rows[0]);
  } catch (error) {
    console.error('Earnings error:', error);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ============================================
// ADMIN ROUTES (Require admin authentication)
// ============================================

// GET /api/affiliate/admin/list - Get all affiliates (admin only)
router.get('/admin/list', authenticate, async (req: AuthRequest, res) => {
  try {
    console.log('Admin list route - user:', req.user);
    console.log('isAdmin value:', req.user?.isAdmin);
    
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

// GET /api/affiliate/admin/commissions - Get all commissions (admin only)
router.get('/admin/commissions', authenticate, async (req: AuthRequest, res) => {
  try {
    console.log('Admin commissions route - user:', req.user);
    console.log('isAdmin value:', req.user?.isAdmin);
    
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

// PUT /api/affiliate/admin/:id/approve - Approve affiliate (admin only)
router.put('/admin/:id/approve', authenticate, async (req: AuthRequest, res) => {
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

// POST /api/affiliate/admin/:id/payout - Mark commissions as paid (admin only)
router.post('/admin/:id/payout', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;

    // Get all pending commissions for this affiliate
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

    // Mark all as paid
    const ids = pendingCommissions.rows.map(c => c.id);
    await db.query(
      `UPDATE affiliate_commissions 
       SET status = 'paid', paid_at = NOW()
       WHERE id = ANY($1::int[])`,
      [ids]
    );

    // Update affiliate's paid/pending earnings
    await db.query(
      `UPDATE affiliates 
       SET pending_earnings = 0,
           paid_earnings = paid_earnings + $1
       WHERE id = $2`,
      [totalAmount, id]
    );

    res.json({ 
      success: true, 
      message: `Marked ${pendingCommissions.rows.length} commissions as paid for $${totalAmount.toFixed(2)}`,
      totalAmount
    });
  } catch (error) {
    console.error('Payout error:', error);
    res.status(500).json({ error: 'Failed to process payout' });
  }
});

// GET /api/affiliate/admin/affiliate/:id - Get single affiliate (admin only)
router.get('/admin/affiliate/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { id } = req.params;
    const affiliate = await db.query(
      `SELECT a.*, 
              COUNT(ar.id) as total_referrals,
              SUM(CASE WHEN ar.status = 'converted' THEN 1 ELSE 0 END) as total_converted
       FROM affiliates a
       LEFT JOIN affiliate_referrals ar ON a.id = ar.affiliate_id
       WHERE a.id = $1
       GROUP BY a.id`,
      [id]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    res.json(affiliate.rows[0]);
  } catch (error) {
    console.error('Failed to fetch affiliate:', error);
    res.status(500).json({ error: 'Failed to fetch affiliate' });
  }
});

export default router;
