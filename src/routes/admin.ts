import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

// Get all clients (for admin only)
router.get('/clients', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        u.id,
        u.email,
        u.name,
        u.created_at,
        u.is_admin,
        p.name as practice_name,
        p.subscription_status
      FROM users u
      LEFT JOIN practices p ON u.practice_id = p.id
      WHERE u.is_admin = FALSE
      ORDER BY u.created_at DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error('Admin clients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific client details
router.get('/clients/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.id;

    const { rows: [client] } = await db.query(`
      SELECT 
        u.id,
        u.email,
        u.name,
        u.created_at,
        p.name as practice_name,
        p.subscription_status
      FROM users u
      LEFT JOIN practices p ON u.practice_id = p.id
      WHERE u.id = $1
    `, [clientId]);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { rows: [stats] } = await db.query(`
      SELECT 
        COUNT(c.id) as total_claims,
        COUNT(a.id) as total_appeals,
        COUNT(CASE WHEN c.status = 'won' THEN 1 END) as won_appeals
      FROM claims c
      LEFT JOIN appeals a ON a.claim_id = c.id
      WHERE c.created_by = $1
    `, [clientId]);

    const { rows: recentClaims } = await db.query(`
      SELECT id, patient_name, insurance_company, status, created_at
      FROM claims
      WHERE created_by = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [clientId]);

    res.json({
      ...client,
      stats,
      recentClaims
    });
  } catch (error) {
    console.error('Admin client detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
