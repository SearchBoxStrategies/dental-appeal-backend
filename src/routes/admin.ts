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
        p.subscription_status,
        p.stripe_customer_id,
        (SELECT COUNT(*) FROM claims WHERE created_by = u.id) as total_claims,
        (SELECT COUNT(*) FROM appeals a JOIN claims c ON a.claim_id = c.id WHERE c.created_by = u.id) as total_appeals
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

// Get specific client details with full stats
router.get('/clients/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.id;

    // Get client info
    const { rows: [client] } = await db.query(`
      SELECT 
        u.id,
        u.email,
        u.name,
        u.created_at,
        p.name as practice_name,
        p.subscription_status,
        p.stripe_customer_id,
        (SELECT MAX(created_at) FROM claims WHERE created_by = u.id) as last_active
      FROM users u
      LEFT JOIN practices p ON u.practice_id = p.id
      WHERE u.id = $1
    `, [clientId]);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Get detailed stats
    const { rows: [stats] } = await db.query(`
      SELECT 
        COUNT(DISTINCT c.id) as total_claims,
        COUNT(DISTINCT a.id) as total_appeals,
        COUNT(CASE WHEN c.status = 'won' THEN 1 END) as won_appeals,
        COUNT(CASE WHEN c.status = 'lost' THEN 1 END) as lost_appeals,
        COUNT(CASE WHEN c.status = 'appealed' THEN 1 END) as pending_appeals,
        ROUND(
          CASE 
            WHEN COUNT(CASE WHEN c.status IN ('won', 'lost') THEN 1 END) > 0 
            THEN (COUNT(CASE WHEN c.status = 'won' THEN 1 END)::numeric / 
                  COUNT(CASE WHEN c.status IN ('won', 'lost') THEN 1 END)::numeric) * 100
            ELSE 0 
          END, 1
        ) as success_rate
      FROM claims c
      LEFT JOIN appeals a ON a.claim_id = c.id
      WHERE c.created_by = $1
    `, [clientId]);

    // Get recent claims with appeal status
    const { rows: recentClaims } = await db.query(`
      SELECT 
        c.id, 
        c.patient_name, 
        c.insurance_company, 
        c.status, 
        c.created_at,
        CASE WHEN a.id IS NOT NULL THEN 'generated' ELSE NULL END as appeal_status,
        a.created_at as appeal_date
      FROM claims c
      LEFT JOIN appeals a ON a.claim_id = c.id
      WHERE c.created_by = $1
      ORDER BY c.created_at DESC
      LIMIT 10
    `, [clientId]);

    // Get payment/summary stats (for when Stripe is integrated)
    const { rows: [paymentStats] } = await db.query(`
      SELECT 
        COALESCE(SUM(amount_paid), 0) as total_paid,
        COUNT(*) as total_transactions,
        MAX(created_at) as last_payment_date
      FROM payments 
      WHERE user_id = $1
    `, [clientId]);

    res.json({
      ...client,
      stats: {
        total_claims: parseInt(stats.total_claims) || 0,
        total_appeals: parseInt(stats.total_appeals) || 0,
        won_appeals: parseInt(stats.won_appeals) || 0,
        lost_appeals: parseInt(stats.lost_appeals) || 0,
        pending_appeals: parseInt(stats.pending_appeals) || 0,
        success_rate: parseFloat(stats.success_rate) || 0
      },
      recentClaims,
      paymentStats: {
        total_paid: parseFloat(paymentStats?.total_paid) || 0,
        total_transactions: parseInt(paymentStats?.total_transactions) || 0,
        last_payment_date: paymentStats?.last_payment_date
      }
    });
  } catch (error) {
    console.error('Admin client detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
