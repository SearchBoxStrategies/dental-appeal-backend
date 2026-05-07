import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

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

export default router;
