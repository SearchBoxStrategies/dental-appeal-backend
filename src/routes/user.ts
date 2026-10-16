import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { sendTwoFactorCodeEmail } from '../services/email';

const router = Router();

// Get email preferences
router.get('/preferences/email', authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { rows: [prefs] } = await db.query(
      `SELECT appeal_updates, payment_receipts, marketing_emails, weekly_digest 
       FROM email_preferences WHERE user_id = $1`,
      [userId]
    );
    
    if (!prefs) {
      return res.json({
        appeal_updates: true,
        payment_receipts: true,
        marketing_emails: false,
        weekly_digest: true,
      });
    }
    
    res.json(prefs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update email preferences
router.put('/preferences/email', authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { appeal_updates, payment_receipts, marketing_emails, weekly_digest } = req.body;
    
    await db.query(
      `INSERT INTO email_preferences (user_id, appeal_updates, payment_receipts, marketing_emails, weekly_digest)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         appeal_updates = EXCLUDED.appeal_updates,
         payment_receipts = EXCLUDED.payment_receipts,
         marketing_emails = EXCLUDED.marketing_emails,
         weekly_digest = EXCLUDED.weekly_digest,
         updated_at = NOW()`,
      [userId, appeal_updates, payment_receipts, marketing_emails, weekly_digest]
    );
    
    res.json({ message: 'Preferences updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// TWO-STEP SIGN-IN (email code) for your own account
// ============================================
// Turning it on is confirmed with a code sent to your email; turning it off needs your password.
// Admin accounts always keep it on.
const twoFactorSettingsLimiter = rateLimit({
  name: '2fa-settings',
  windowMs: 15 * 60_000,
  max: 10,
  key: req => (req.user ? `user:${req.user.userId}` : req.ip),
  message: 'Too many attempts. Please wait 15 minutes and try again.',
});

router.post('/2fa/start', authenticate, twoFactorSettingsLimiter, async (req, res) => {
  try {
    const { rows: [user] } = await db.query('SELECT id, email, name FROM users WHERE id = $1', [req.user!.userId]);
    const code = String(crypto.randomInt(100000, 1000000));
    await db.query(
      `UPDATE users SET two_factor_code = $1, two_factor_expires = NOW() + INTERVAL '10 minutes' WHERE id = $2`,
      [code, user.id]
    );
    await sendTwoFactorCodeEmail(user.email, code, user.name);
    res.json({ success: true, email: user.email });
  } catch (error) {
    console.error('2FA start error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/2fa/confirm', authenticate, twoFactorSettingsLimiter, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    const { rows: [user] } = await db.query(
      'SELECT two_factor_code, two_factor_expires FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (!user?.two_factor_code || new Date() > user.two_factor_expires || user.two_factor_code !== code) {
      return res.status(400).json({ error: 'That code is wrong or has expired. Request a new one.' });
    }
    await db.query(
      'UPDATE users SET two_factor_enabled = TRUE, two_factor_code = NULL, two_factor_expires = NULL WHERE id = $1',
      [req.user!.userId]
    );
    res.json({ success: true, two_factor_enabled: true });
  } catch (error) {
    console.error('2FA confirm error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/2fa/disable', authenticate, twoFactorSettingsLimiter, async (req, res) => {
  try {
    if (req.user!.isAdmin) return res.status(400).json({ error: 'Admin accounts must keep two-step sign-in on.' });
    const password = String(req.body?.password || '');
    const { rows: [user] } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.userId]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(400).json({ error: 'Password is incorrect.' });
    }
    await db.query('UPDATE users SET two_factor_enabled = FALSE WHERE id = $1', [req.user!.userId]);
    res.json({ success: true, two_factor_enabled: false });
  } catch (error) {
    console.error('2FA disable error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
