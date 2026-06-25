import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import crypto from 'crypto';
import { db } from '../db';
import { sendVerificationEmail, sendPasswordResetEmail, sendAdminVerificationCode } from '../services/email';

const router = Router();

// Helper: Generate 6-digit verification code
const generateVerificationCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const registerSchema = z.object({
  practiceName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  referralCode: z.string().optional(),
});

router.post('/register', async (req, res) => {
  console.log('Register endpoint hit');
  try {
    const { practiceName, name, email, password, referralCode } = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      let referredByAffiliateId = null;
      if (referralCode) {
        const { rows: [affiliate] } = await client.query(
          'SELECT id FROM affiliates WHERE affiliate_code = $1 AND is_active = true',
          [referralCode]
        );
        if (affiliate) {
          referredByAffiliateId = affiliate.id;
          await client.query(
            `UPDATE affiliate_referrals 
             SET signed_up_at = NOW(), status = 'signed_up'
             WHERE referral_code = $1 AND signed_up_at IS NULL`,
            [referralCode]
          );
        }
      }

      let practiceId;
      const { rows: existingPractice } = await client.query(
        'SELECT id FROM practices WHERE email = $1',
        [email]
      );
      
      if (existingPractice.length > 0) {
        practiceId = existingPractice[0].id;
      } else {
        const { rows: [practice] } = await client.query(
          `INSERT INTO practices (name, email, subscription_status, referred_by_affiliate_id, referral_code_used) 
           VALUES ($1, $2, 'inactive', $3, $4) RETURNING id`,
          [practiceName, email, referredByAffiliateId, referralCode]
        );
        practiceId = practice.id;
        
        if (referredByAffiliateId) {
          await client.query(
            'UPDATE affiliates SET total_signups = total_signups + 1 WHERE id = $1',
            [referredByAffiliateId]
          );
        }
      }

      const verificationToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date();
      tokenExpiry.setHours(tokenExpiry.getHours() + 24);

      const { rows: [user] } = await client.query(
        `INSERT INTO users (practice_id, email, password_hash, name, role, verification_token, verification_token_expires)
         VALUES ($1, $2, $3, $4, 'admin', $5, $6) 
         ON CONFLICT (practice_id, email) DO UPDATE SET 
           name = $4, 
           password_hash = $3,
           verification_token = $5,
           verification_token_expires = $6
         RETURNING id, email, name, role, verification_token`,
        [practiceId, email, passwordHash, name, verificationToken, tokenExpiry]
      );

      await client.query('COMMIT');
      await sendVerificationEmail(email, verificationToken, practiceName);

      res.status(201).json({
        message: 'Registration successful. Please check your email to verify your account.',
        email: user.email,
        requiresVerification: true
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Registration error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    const err = error as any;
    if (err.code === '23505') {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const { rows: [user] } = await db.query(
      `SELECT id, email, verification_token, verification_token_expires 
       FROM users 
       WHERE verification_token = $1 AND email_verified = FALSE`,
      [token]
    );
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }
    
    if (new Date() > user.verification_token_expires) {
      return res.status(400).json({ error: 'Verification link has expired. Please request a new one.' });
    }
    
    await db.query(
      `UPDATE users 
       SET email_verified = TRUE, 
           email_verified_at = NOW(), 
           verification_token = NULL,
           verification_token_expires = NULL
       WHERE id = $1`,
      [user.id]
    );
    
    res.redirect(`${process.env.FRONTEND_URL}/login?verified=true`);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    const { rows: [user] } = await db.query(
      `SELECT u.id, u.email, u.practice_id, u.email_verified, p.name as practice_name
       FROM users u
       LEFT JOIN practices p ON u.practice_id = p.id
       WHERE u.email = $1`,
      [email]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.email_verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }
    
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date();
    tokenExpiry.setHours(tokenExpiry.getHours() + 24);
    
    await db.query(
      `UPDATE users 
       SET verification_token = $1, 
           verification_token_expires = $2 
       WHERE id = $3`,
      [verificationToken, tokenExpiry, user.id]
    );
    
    await sendVerificationEmail(email, verificationToken, user.practice_name);
    
    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// =============================================
// SIMPLE LOGIN - Bypasses all checks
// Use this to get into the admin portal
// Remove this version and restore proper auth after login
// =============================================
router.post('/login', async (req, res) => {
  console.log('🔐 SIMPLE LOGIN - bypass all checks');
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { rows: [user] } = await db.query(
      `SELECT u.*, p.name as practice_name, p.subscription_status 
       FROM users u 
       LEFT JOIN practices p ON u.practice_id = p.id 
       WHERE u.email = $1`,
      [email]
    );

    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Simple password check
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      console.log('❌ Invalid password for:', email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate token - ignore is_admin, just log them in
    const token = jwt.sign(
      { 
        userId: user.id, 
        practiceId: user.practice_id, 
        role: user.role, 
        practiceName: user.practice_name 
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    console.log('✅ LOGIN SUCCESS for:', email);
    console.log('👤 is_admin:', user.is_admin);

    res.json({
      token,
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role,
        email_verified: user.email_verified,
        is_admin: user.is_admin
      },
      practice: {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/verify-admin-code', async (req, res) => {
  try {
    const { userId, code } = req.body;
    
    const { rows: [user] } = await db.query(
      `SELECT id, email, name, admin_verification_code, admin_verification_expires, 
              admin_verification_attempts, practice_id
       FROM users 
       WHERE id = $1 AND is_admin = TRUE`,
      [userId]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found or not an admin' });
    }
    
    if (user.admin_verification_attempts >= 5) {
      return res.status(400).json({ error: 'Too many failed attempts. Please request a new code.' });
    }
    
    if (!user.admin_verification_code || new Date() > user.admin_verification_expires) {
      return res.status(400).json({ error: 'Verification code expired. Please request a new one.' });
    }
    
    if (user.admin_verification_code !== code) {
      await db.query(
        'UPDATE users SET admin_verification_attempts = admin_verification_attempts + 1 WHERE id = $1',
        [userId]
      );
      return res.status(400).json({ error: 'Invalid verification code' });
    }
    
    await db.query(
      `UPDATE users 
       SET admin_verification_code = NULL, 
           admin_verification_expires = NULL,
           admin_verification_attempts = 0
       WHERE id = $1`,
      [userId]
    );
    
    const { rows: [practice] } = await db.query(
      'SELECT name, subscription_status FROM practices WHERE id = $1',
      [user.practice_id]
    );
    
    const token = jwt.sign(
      { 
        userId: user.id, 
        practiceId: user.practice_id, 
        role: 'admin', 
        practiceName: practice.name 
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: 'admin',
        is_admin: true
      },
      practice: {
        id: user.practice_id,
        name: practice.name,
        subscriptionStatus: practice.subscription_status,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/resend-admin-code', async (req, res) => {
  try {
    const { userId } = req.body;
    
    const { rows: [user] } = await db.query(
      'SELECT id, email, name FROM users WHERE id = $1 AND is_admin = TRUE',
      [userId]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const verificationCode = generateVerificationCode();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 10);
    
    await db.query(
      `UPDATE users 
       SET admin_verification_code = $1, 
           admin_verification_expires = $2,
           admin_verification_attempts = 0
       WHERE id = $3`,
      [verificationCode, expiresAt, user.id]
    );
    
    await sendAdminVerificationCode(user.email, verificationCode, user.name);
    
    res.json({ message: 'Verification code sent' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const { rows: [user] } = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.is_admin, u.email_verified, u.user_type,
              p.id as practice_id, p.name as practice_name, p.subscription_status 
       FROM users u 
       LEFT JOIN practices p ON u.practice_id = p.id 
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Get affiliate data if user is an affiliate
    let affiliateData = null;
    if (user.user_type === 'affiliate') {
      const { rows: [affiliate] } = await db.query(
        `SELECT affiliate_code, is_active, approved_at, commission_rate, tier,
                total_clicks, total_signups, total_conversions, total_earnings, pending_earnings
         FROM affiliates 
         WHERE user_id = $1`,
        [user.id]
      );
      affiliateData = affiliate;
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_admin: user.is_admin,
        email_verified: user.email_verified,
        user_type: user.user_type || (user.is_admin ? 'admin' : 'clinic'),
        affiliate: affiliateData ? {
          code: affiliateData.affiliate_code,
          is_active: affiliateData.is_active,
          approved_at: affiliateData.approved_at,
          commission_rate: affiliateData.commission_rate,
          tier: affiliateData.tier,
          stats: {
            clicks: affiliateData.total_clicks || 0,
            signups: affiliateData.total_signups || 0,
            conversions: affiliateData.total_conversions || 0,
            earnings: affiliateData.total_earnings || 0,
            pending: affiliateData.pending_earnings || 0
          }
        } : null
      },
      practice: user.practice_id ? {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      } : null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    
    const { rows: users } = await db.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [email]
    );
    
    if (users.length === 0) {
      res.json({ message: 'If an account exists, a reset link has been sent' });
      return;
    }
    
    const user = users[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const tokenExpiry = Date.now() + 60 * 60 * 1000;
    
    await db.query(
      'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3',
      [hashedToken, tokenExpiry, user.id]
    );
    
    await sendPasswordResetEmail(email, resetToken, user.name);
    
    res.json({ message: 'If an account exists, a reset link has been sent' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/reset-password/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    
    if (!password || password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }
    
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    const { rows: users } = await db.query(
      'SELECT id FROM users WHERE reset_password_token = $1 AND reset_password_expires > $2',
      [hashedToken, Date.now()]
    );
    
    if (users.length === 0) {
      res.status(400).json({ error: 'Invalid or expired token' });
      return;
    }
    
    const user = users[0];
    const hashedPassword = await bcrypt.hash(password, 10);
    
    await db.query(
      'UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
      [hashedPassword, user.id]
    );
    
    res.json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================
// TEMPORARY ENDPOINT - REMOVE AFTER USE
// Generates bcrypt hash for admin password reset
// =============================================
router.get('/admin-hash', async (req, res) => {
  try {
    const password = 'M1gu3l+R3g1s';
    const hash = await bcrypt.hash(password, 10);
    res.json({
      success: true,
      password: password,
      hash: hash,
      sql: `UPDATE users SET password_hash = '${hash}' WHERE id = 42;`
    });
  } catch (error) {
    console.error('Error generating hash:', error);
    res.status(500).json({ error: String(error) });
  }
});

// =============================================
// TEMPORARY DEBUG ENDPOINT - REMOVE AFTER USE
// Tests password comparison
// =============================================
router.post('/debug-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const { rows: [user] } = await db.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );
    
    if (!user) {
      return res.json({ success: false, error: 'User not found' });
    }
    
    const isValid = await bcrypt.compare(password, user.password_hash);
    
    res.json({
      success: true,
      email: user.email,
      passwordProvided: password,
      hashStored: user.password_hash,
      isValid: isValid,
      hashLength: user.password_hash?.length
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// =============================================
// TEMPORARY - Direct token generator - REMOVE AFTER USE
// =============================================
router.post('/get-token', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Get user without relying on practices join
    const { rows: [user] } = await db.query(
      `SELECT u.*, p.name as practice_name, p.subscription_status 
       FROM users u 
       LEFT JOIN practices p ON u.practice_id = p.id 
       WHERE u.email = $1`,
      [email]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const token = jwt.sign(
      { 
        userId: user.id, 
        practiceId: user.practice_id || 0, 
        role: user.role || 'admin', 
        practiceName: user.practice_name || 'Admin' 
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );
    
    res.json({
      success: true,
      token: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_admin: user.is_admin,
        user_type: user.user_type
      }
    });
  } catch (error) {
    console.error('❌ Get token error:', error);
    res.status(500).json({ error: String(error) });
  }
});

export default router;
