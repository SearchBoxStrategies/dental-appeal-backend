import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

// Generate unique affiliate code
function generateAffiliateCode(email: string): string {
  const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${random}`;
}

// Public: Affiliate signup (from landing page)
router.post('/affiliate/signup', async (req, res) => {
  const { fullName, email, companyName, payoutEmail, payoutMethod } = req.body;

  try {
    const existing = await db.query(
      'SELECT id FROM affiliates WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Affiliate already registered' });
    }

    const affiliateCode = generateAffiliateCode(email);

    const result = await db.query(
      `INSERT INTO affiliates (full_name, email, company_name, affiliate_code, payout_email, payout_method, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, affiliate_code`,
      [fullName, email, companyName, affiliateCode, payoutEmail, payoutMethod]
    );

    // TODO: Send welcome email with affiliate link

    res.json({
      success: true,
      affiliateCode: result.rows[0].affiliate_code,
      affiliateLink: `${process.env.FRONTEND_URL}/register?ref=${result.rows[0].affiliate_code}`,
      message: 'Affiliate registered successfully'
    });
  } catch (error) {
    console.error('Affiliate signup error:', error);
    res.status(500).json({ error: 'Failed to register affiliate' });
  }
});

// Track affiliate click (public)
router.get('/affiliate/track/:code', async (req, res) => {
  const { code } = req.params;
  const ip = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const affiliate = await db.query(
      'SELECT id FROM affiliates WHERE affiliate_code = $1 AND is_active = true',
      [code]
    );

    if (affiliate.rows.length > 0) {
      await db.query(
        `INSERT INTO affiliate_referrals (affiliate_id, referral_code, click_ip, click_user_agent)
         VALUES ($1, $2, $3, $4)`,
        [affiliate.rows[0].id, code, ip, userAgent]
      );

      await db.query(
        'UPDATE affiliates SET total_clicks = total_clicks + 1 WHERE id = $1',
        [affiliate.rows[0].id]
      );
    }

    // Redirect to registration page
    res.redirect(`${process.env.FRONTEND_URL}/register?ref=${code}`);
  } catch (error) {
    console.error('Track error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/register`);
  }
});

// Get affiliate dashboard data (authenticated)
router.get('/affiliate/dashboard', authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const userEmail = req.user!.email;

    const affiliate = await db.query(
      `SELECT id, affiliate_code, tier, commission_rate, total_clicks, total_signups, 
              total_conversions, total_earnings, pending_earnings, paid_earnings, payout_email
       FROM affiliates 
       WHERE email = $1`,
      [userEmail]
    );

    if (affiliate.rows.length === 0) {
      return res.status(404).json({ error: 'Affiliate not found' });
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

    res.json({
      affiliate: affiliate.rows[0],
      referrals: referrals.rows,
      commissions: commissions.rows
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Get affiliate link
router.get('/affiliate/link', authenticate, async (req, res) => {
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

// Get affiliate stats (public)
router.get('/affiliate/stats/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const affiliate = await db.query(
      `SELECT affiliate_code, total_clicks, total_signups, total_conversions
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

export default router;
