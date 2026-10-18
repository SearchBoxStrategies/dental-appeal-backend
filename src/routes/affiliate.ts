import { Router, Request } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { createConnectAccount, createAccountOnboardingLink, createAccountLoginLink, getAccountStatus, SUPPORTED_AFFILIATE_COUNTRIES, AffiliateCountry } from '../services/stripeConnect';
import { sendEmail, sendAffiliateVerificationEmail } from '../services/email';
import { getNextTierInfo, updateAffiliateTierColumn } from '../utils/affiliateTiers';

const router = Router();

const generateAffiliateCode = (email: string): string => {
  const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${random}`;
};

// Helper function to check if affiliate is approved
const checkAffiliateApproval = async (userId: number) => {
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
  console.log('🔵 AFFILIATE SIGNUP CALLED');
  const { fullName, email, companyName, payoutEmail, payoutMethod } = req.body;
  console.log(`📧 FullName: ${fullName}, Email: ${email}`);

  if (!fullName || !email) {
    return res.status(400).json({ error: 'Full name and email are required' });
  }

  // Default to 'stripe' if no payout method provided
  const payoutMethodValue = payoutMethod || 'stripe';

  const client = await db.connect();
  let verification: { link: string } | null = null;
  let affiliateCode: string;
  try {
    await client.query('BEGIN');

    // Check if user already exists in users table
    const { rows: [existingUser] } = await client.query(
      'SELECT id, email, user_type, email_verified FROM users WHERE lower(email) = lower($1) FOR UPDATE',
      [email]
    );

    let userId: number;

    if (existingUser) {
      // Already an affiliate? Deleted or rejected applications don't count: the person may apply again.
      const { rows: [existingAffiliate] } = await client.query(
        'SELECT id, affiliate_code, is_active FROM affiliates WHERE user_id = $1 AND deleted_at IS NULL',
        [existingUser.id]
      );

      if (existingAffiliate) {
        await client.query('ROLLBACK');
        const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${existingAffiliate.affiliate_code}`;
        return res.json({
          success: true,
          alreadyExists: true,
          pendingApproval: !existingAffiliate.is_active,
          affiliateCode: existingAffiliate.affiliate_code,
          affiliateLink,
          message: existingAffiliate.is_active
            ? 'You are already registered as an affiliate!'
            : 'You are already registered but your account is pending admin approval.'
        });
      }

      userId = existingUser.id;

      // An old deleted application keeps its history but no longer belongs to this login, so every
      // "affiliate for this user" lookup finds only the new application.
      await client.query(
        'UPDATE affiliates SET user_id = NULL WHERE user_id = $1 AND deleted_at IS NOT NULL',
        [userId]
      );

      // Never verified (e.g. an earlier attempt that failed): send a fresh link.
      if (existingUser.user_type === 'affiliate' && !existingUser.email_verified) {
        const verificationToken = crypto.randomBytes(32).toString('hex');
        await client.query(
          `UPDATE users SET verification_token = $1, verification_token_expires = NOW() + INTERVAL '24 hours' WHERE id = $2`,
          [verificationToken, userId]
        );
        verification = { link: `${process.env.FRONTEND_URL}/affiliate/verify?token=${verificationToken}` };
      }
    } else {
      // Create new user (no password - they'll set it via email verification)
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date();
      tokenExpiry.setHours(tokenExpiry.getHours() + 24);

      const userResult = await client.query(
        `INSERT INTO users (email, name, user_type, is_admin, verification_token, verification_token_expires, email_verified, created_at)
         VALUES ($1, $2, 'affiliate', false, $3, $4, false, NOW())
         RETURNING id`,
        [email, fullName, verificationToken, tokenExpiry]
      );
      userId = userResult.rows[0].id;
      verification = { link: `${process.env.FRONTEND_URL}/affiliate/verify?token=${verificationToken}` };
    }

    // Create new affiliate record
    affiliateCode = generateAffiliateCode(email);

    await client.query(
      `INSERT INTO affiliates (user_id, full_name, email, company_name, affiliate_code, payout_email, payout_method, is_active, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)`,
      [userId, fullName, email, companyName || null, affiliateCode, payoutEmail || null, payoutMethodValue, null]
    );

    await client.query('COMMIT');
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'An affiliate application with this email already exists. Please sign in or contact support.' });
    }
    console.error('Affiliate signup error:', error);
    return res.status(500).json({ error: 'Failed to register affiliate' });
  } finally {
    client.release();
  }

  // Email only after the application is saved, so a failed sign-up never sends a dead link.
  if (verification) {
    try {
      await sendAffiliateVerificationEmail(email, fullName, verification.link);
      console.log(`✅ Verification email sent to ${email}`);
    } catch (error) {
      console.error(`❌ Failed to send verification email to ${email}:`, error);
    }
  }

  {
    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliateCode}`;

    res.json({
      success: true,
      affiliateCode: affiliateCode,
      affiliateLink,
      message: 'Registration successful! Please check your email to verify your account. Your affiliate account will be active after admin approval.',
      pendingApproval: true,
      requiresVerification: true
    });
  }
});

// Verify affiliate email
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    const { rows: [user] } = await db.query(
      `SELECT id, email, name, verification_token, verification_token_expires, email_verified
       FROM users
       WHERE verification_token = $1 AND user_type = 'affiliate' AND email_verified = false`,
      [token]
    );

    if (!user) {
      return res.redirect(`${process.env.FRONTEND_URL}/affiliate/verify?error=invalid`);
    }

    if (new Date() > user.verification_token_expires) {
      return res.redirect(`${process.env.FRONTEND_URL}/affiliate/verify?error=expired`);
    }

    // Mark email as verified and issue a one-time setup token (valid 1 hour) that the
    // set-password step must present, so knowing the email alone can't claim the account.
    const setupToken = crypto.randomBytes(32).toString('hex');
    await db.query(
      `UPDATE users
       SET email_verified = true,
           email_verified_at = NOW(),
           verification_token = $2,
           verification_token_expires = NOW() + INTERVAL '1 hour'
       WHERE id = $1`,
      [user.id, setupToken]
    );

    // Redirect to set password page
    res.redirect(`${process.env.FRONTEND_URL}/affiliate/set-password?email=${encodeURIComponent(user.email)}&verified=true&token=${setupToken}`);
  } catch (error) {
    console.error('Affiliate verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Set password for verified affiliate
router.post('/set-password', async (req, res) => {
  try {
    const { email, password, token } = req.body;

    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email and password (min 6 characters) are required' });
    }
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'This link is missing its setup code. Please use the link from your verification email.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `UPDATE users
       SET password_hash = $1,
           verification_token = NULL,
           verification_token_expires = NULL
       WHERE email = $2
         AND verification_token = $3
         AND verification_token_expires > NOW()
         AND email_verified = true
         AND (password_hash IS NULL OR password_hash = '')
       RETURNING id, email`,
      [passwordHash, email, token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'This setup link is invalid or expired, or the password is already set. Request a new verification email.' });
    }

    res.json({ success: true, message: 'Password set successfully. You can now log in.' });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// Resend verification email
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    const { rows: [user] } = await db.query(
      `SELECT id, email, name, email_verified, user_type,
              (password_hash IS NULL OR password_hash = '') AS needs_password
       FROM users
       WHERE email = $1 AND user_type = 'affiliate'`,
      [email]
    );

    if (!user) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    // Verified affiliates who never set a password (setup link expired) can get a fresh link.
    if (user.email_verified && !user.needs_password) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 24);

    await db.query(
      `UPDATE users
       SET verification_token = $1, verification_token_expires = $2, email_verified = false
       WHERE id = $3`,
      [verificationToken, tokenExpiry, user.id]
    );

    const verificationLink = `${process.env.FRONTEND_URL}/affiliate/verify?token=${verificationToken}`;
    console.log(`📧 Resending verification email to ${user.email}`);
    try {
      await sendAffiliateVerificationEmail(user.email, user.name, verificationLink);
      console.log(`✅ Resent verification email to ${user.email}`);
    } catch (error) {
      console.error(`❌ Failed to resend verification email to ${user.email}:`, error);
    }

    res.json({ success: true, message: 'Verification email resent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification email' });
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

      res.cookie('affiliate_ref', code, {
        maxAge: 90 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/'
      });
    }

    // counted=1: the click is already recorded, so the app only remembers the code.
    res.redirect(`${process.env.FRONTEND_URL}/register?ref=${encodeURIComponent(code)}&counted=1`);
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

    // Get next tier info
    const nextTier = await getNextTierInfo(affiliate.id);

    const { rows: referrals } = await db.query(
      `SELECT ar.id, ar.referral_code, ar.status, ar.clicked_at, ar.signed_up_at, ar.converted_at,
              ar.practice_id, p.name AS practice_name, p.subscription_status
       FROM affiliate_referrals ar
       LEFT JOIN practices p ON p.id = ar.practice_id
       WHERE ar.affiliate_id = $1
       ORDER BY ar.clicked_at DESC
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
      monthlyEarnings,
      nextTier
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
      const country = String(req.body?.country || 'US').toUpperCase();
      if (!(SUPPORTED_AFFILIATE_COUNTRIES as readonly string[]).includes(country)) {
        return res.status(400).json({ error: 'Payouts are available to affiliates in the US and Canada' });
      }
      const account = await createConnectAccount(affiliate.id, affiliate.email, affiliate.full_name, country as AffiliateCountry);
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

    // Sync from Stripe directly: account.updated events for connected accounts arrive on a
    // separate Connect webhook, so don't rely on them alone. Monthly payouts are switched on
    // automatically the first time an account becomes payable.
    let accountStatus = affiliate.stripe_account_status;
    let autoPayout = affiliate.auto_payout_enabled;
    if (status) {
      const isActive = !!(status.payouts_enabled && status.details_submitted);
      const newStatus = isActive ? 'verified' : 'pending';
      if (newStatus !== accountStatus) {
        const { rows: [updated] } = await db.query(
          `UPDATE affiliates
           SET stripe_account_status = $1,
               auto_payout_enabled = CASE WHEN $2 AND stripe_onboarded_at IS NULL THEN true ELSE auto_payout_enabled END,
               stripe_onboarded_at = CASE WHEN $2 AND stripe_onboarded_at IS NULL THEN NOW() ELSE stripe_onboarded_at END
           WHERE user_id = $3
           RETURNING stripe_account_status, auto_payout_enabled`,
          [newStatus, isActive, userId]
        );
        accountStatus = updated.stripe_account_status;
        autoPayout = updated.auto_payout_enabled;
      }
    }

    res.json({
      hasAccount: true,
      status: accountStatus,
      details_submitted: status?.details_submitted,
      payouts_enabled: status?.payouts_enabled,
      auto_payout_enabled: autoPayout,
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
           commission_rate = COALESCE($1, 20),
           tier = COALESCE($2, 'standard')
       WHERE id = $3`,
      [commissionRate || 20, tier || 'standard', id]
    );
    // Rates come from the program tiers (20/25/30% by monthly conversions), not a fixed number.
    await updateAffiliateTierColumn(Number(id));

    res.json({
      success: true,
      message: 'Affiliate approved successfully'
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

    const totalAmount = Math.round(pendingCommissions.rows.reduce((sum, c) => sum + parseFloat(c.amount), 0) * 100) / 100;
    const ids = pendingCommissions.rows.map(c => c.id);

    // Paid outside Stripe (e.g. e-transfer): mark the commissions, move the balance and keep a
    // payout record, all or nothing.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE affiliate_commissions
         SET status = 'paid', paid_at = NOW()
         WHERE id = ANY($1::int[]) AND status = 'pending'`,
        [ids]
      );
      await client.query(
        `UPDATE affiliates
         SET pending_earnings = pending_earnings - $1,
             paid_earnings = paid_earnings + $1
         WHERE id = $2`,
        [totalAmount, id]
      );
      await client.query(
        `INSERT INTO payout_logs (affiliate_id, amount, status, stripe_transfer_id, error_message, processed_at)
         VALUES ($1, $2, 'success', $3, 'Marked paid manually by admin', NOW())`,
        [id, totalAmount, `manual-${id}-${Date.now()}`]
      );
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK').catch(() => {});
      throw txError;
    } finally {
      client.release();
    }

    res.json({
      success: true,
      message: `Marked ${pendingCommissions.rows.length} commissions as paid for $${totalAmount.toFixed(2)}`
    });
  } catch (error) {
    console.error('Payout error:', error);
    res.status(500).json({ error: 'Failed to process payout' });
  }
});

// Admin: Recalculate all affiliate tiers
router.post('/admin/recalculate-tiers', authenticate, async (req: Request, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { rows: affiliates } = await db.query(
      'SELECT id FROM affiliates'
    );

    let updated = 0;
    for (const affiliate of affiliates) {
      await updateAffiliateTierColumn(affiliate.id);
      updated++;
    }

    res.json({
      success: true,
      message: `Recalculated tiers for ${updated} affiliates`,
      totalAffiliates: affiliates.length
    });
  } catch (error) {
    console.error('Recalculate tiers error:', error);
    res.status(500).json({ error: 'Failed to recalculate tiers' });
  }
});

export default router;
