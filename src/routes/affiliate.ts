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
  const { fullName, email, companyName, payoutEmail, payoutMethod } = req.body;

  if (!fullName || !email) {
    return res.status(400).json({ error: 'Full name and email are required' });
  }

  try {
    // Check if user already exists in users table
    const existingUser = await db.query(
      'SELECT id, email, user_type FROM users WHERE email = $1',
      [email]
    );

    let userId: number;

    if (existingUser.rows.length > 0) {
      // User exists - check if they're already an affiliate
      const existingAffiliate = await db.query(
        'SELECT id, affiliate_code, is_active FROM affiliates WHERE user_id = $1',
        [existingUser.rows[0].id]
      );

      if (existingAffiliate.rows.length > 0) {
        const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${existingAffiliate.rows[0].affiliate_code}`;
        
        if (!existingAffiliate.rows[0].is_active) {
          return res.json({
            success: true,
            alreadyExists: true,
            pendingApproval: true,
            affiliateCode: existingAffiliate.rows[0].affiliate_code,
            affiliateLink,
            message: 'You are already registered but your account is pending admin approval.'
          });
        }
        
        return res.json({
          success: true,
          alreadyExists: true,
          pendingApproval: false,
          affiliateCode: existingAffiliate.rows[0].affiliate_code,
          affiliateLink,
          message: 'You are already registered as an affiliate!'
        });
      }
      
      userId = existingUser.rows[0].id;
    } else {
      // Create new user with NULL password_hash (they'll set it later via forgot password)
      const userResult = await db.query(
        `INSERT INTO users (email, name, user_type, is_admin, password_hash, created_at)
         VALUES ($1, $2, 'affiliate', false, NULL, NOW())
         RETURNING id`,
        [email, fullName]
      );
      userId = userResult.rows[0].id;
    }

    // Check if affiliate already exists for this user
    const existingAffiliate = await db.query(
      'SELECT id, affiliate_code FROM affiliates WHERE user_id = $1',
      [userId]
    );

    if (existingAffiliate.rows.length > 0) {
      const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${existingAffiliate.rows[0].affiliate_code}`;
      return res.json({
        success: true,
        alreadyExists: true,
        affiliateCode: existingAffiliate.rows[0].affiliate_code,
        affiliateLink,
        message: 'Affiliate account already exists.'
      });
    }

    // Create new affiliate record
    const affiliateCode = generateAffiliateCode(email);
    
    const result = await db.query(
      `INSERT INTO affiliates (user_id, full_name, email, company_name, affiliate_code, payout_email, payout_method, is_active, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, NULL)
       RETURNING id, affiliate_code`,
      [userId, fullName, email, companyName || null, affiliateCode, payoutEmail || null, payoutMethod || null]
    );

    const affiliateLink = `${process.env.FRONTEND_URL}/register?ref=${affiliateCode}`;

    res.json({
      success: true,
      affiliateCode: result.rows[0].affiliate_code,
      affiliateLink,
      message: 'Registration successful! Your account is pending admin approval. You will receive an email with instructions to set your password once approved.',
      pendingApproval: true
    });
  } catch (error) {
    console.error('Affiliate signup error:', error);
    res.status(500).json({ error: 'Failed to register affiliate' });
  }
});

// The rest of your affiliate.ts routes (track, stats, dashboard, etc.) remain the same...

export default router;
