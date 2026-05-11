import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import crypto from 'crypto';
import { db } from '../db';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email';

const router = Router();

const registerSchema = z.object({
  practiceName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

router.post('/register', async (req, res) => {
  console.log('Register endpoint hit');
  try {
    const { practiceName, name, email, password } = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Check if practice already exists
      let practiceId;
      const { rows: existingPractice } = await client.query(
        'SELECT id FROM practices WHERE email = $1',
        [email]
      );
      
      if (existingPractice.length > 0) {
        practiceId = existingPractice[0].id;
      } else {
        const { rows: [practice] } = await client.query(
          'INSERT INTO practices (name, email, subscription_status) VALUES ($1, $2, $3) RETURNING id',
          [practiceName, email, 'inactive']
        );
        practiceId = practice.id;
      }

      // Generate verification token
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

      // Send verification email
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
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify email with token
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
    
    // Redirect to login with success message
    res.redirect(`${process.env.FRONTEND_URL}/login?verified=true`);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Resend verification email
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    const { rows: [user] } = await db.query(
      `SELECT u.id, u.email, u.practice_id, u.email_verified, p.name as practice_name
       FROM users u
       JOIN practices p ON u.practice_id = p.id
       WHERE u.email = $1`,
      [email]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.email_verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }
    
    // Generate new token
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

router.post('/login', async (req, res) => {
  console.log('Login endpoint hit');
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { rows: [user] } = await db.query(
      `SELECT u.*, p.name as practice_name, p.subscription_status 
       FROM users u 
       JOIN practices p ON u.practice_id = p.id 
       WHERE u.email = $1`,
      [email]
    );

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Check if email is verified
    if (!user.email_verified) {
      res.status(401).json({ 
        error: 'Please verify your email address before logging in',
        requiresVerification: true,
        email: user.email
      });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

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

    res.json({
      token,
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role,
        email_verified: user.email_verified
      },
      practice: {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
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
      `SELECT u.id, u.email, u.name, u.role, u.is_admin, u.email_verified,
              p.id as practice_id, p.name as practice_name, p.subscription_status 
       FROM users u 
       JOIN practices p ON u.practice_id = p.id 
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role,
        is_admin: user.is_admin,
        email_verified: user.email_verified
      },
      practice: {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Forgot password - Request reset link
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    
    // Check if user exists
    const { rows: users } = await db.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [email]
    );
    
    if (users.length === 0) {
      // For security, don't reveal that email doesn't exist
      res.json({ message: 'If an account exists, a reset link has been sent' });
      return;
    }
    
    const user = users[0];
    
    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const tokenExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
    
    await db.query(
      'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3',
      [hashedToken, tokenExpiry, user.id]
    );
    
    // Send password reset email
    await sendPasswordResetEmail(email, resetToken, user.name);
    
    res.json({ message: 'If an account exists, a reset link has been sent' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password - Use token to set new password
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

export default router;
