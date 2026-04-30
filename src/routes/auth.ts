import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

const registerSchema = z.object({
  practiceName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

router.post('/register', async (req, res) => {
  try {
    const { practiceName, name, email, password } = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: [practice] } = await client.query(
        'INSERT INTO practices (name, email) VALUES ($1, $2) RETURNING id, name',
        [practiceName, email]
      );

      const { rows: [user] } = await client.query(
        `INSERT INTO users (practice_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'admin') RETURNING id, email, name, role`,
        [practice.id, email, passwordHash, name]
      );

      await client.query('COMMIT');

      const token = jwt.sign(
        { userId: user.id, practiceId: practice.id, role: user.role, practiceName: practice.name },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        practice: { id: practice.id, name: practice.name, subscriptionStatus: 'inactive' },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('unique')) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { rows: [user] } = await db.query(
      'SELECT u.*, p.name as practice_name, p.subscription_status FROM users u JOIN practices p ON u.practice_id = p.id WHERE u.email = $1',
      [email]
    );

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, practiceId: user.practice_id, role: user.role, practiceName: user.practice_name },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      practice: {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows: [user] } = await db.query(
      'SELECT u.id, u.email, u.name, u.role, p.id as practice_id, p.name as practice_name, p.subscription_status FROM users u JOIN practices p ON u.practice_id = p.id WHERE u.id = $1',
      [req.user!.userId]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
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
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        
        if (users.length === 0) {
            // For security, don't reveal that email doesn't exist
            res.json({ message: 'If an account exists, a reset link has been sent' });
            return;
        }
        
        // Import the service functions
        const { createResetToken, saveResetToken, sendResetEmail } = require('../services/passwordRecovery');
        
        // Generate and save token
        const { resetToken, hashedToken, tokenExpiry } = createResetToken();
        await saveResetToken(email, hashedToken, tokenExpiry);
        
        // Send email (logs URL to console in development)
        await sendResetEmail(email, resetToken);
        
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
        
        const { verifyResetToken, updatePassword } = require('../services/passwordRecovery');
        const bcrypt = require('bcryptjs');
        
        // Verify token
        const user = await verifyResetToken(token);
        
        if (!user) {
            res.status(400).json({ error: 'Invalid or expired token' });
            return;
        }
        
        // Hash new password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Update password
        await updatePassword(user.id, hashedPassword);
        
        res.json({ message: 'Password has been reset successfully' });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
export default router;
