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

// Get client notes
router.get('/clients/:id/notes', authenticate, requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.id;
    
    const { rows } = await db.query(`
      SELECT 
        cn.*,
        u.name as author_name
      FROM client_notes cn
      LEFT JOIN users u ON cn.author_id = u.id
      WHERE cn.client_id = $1
      ORDER BY cn.created_at DESC
    `, [clientId]);
    
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Add client note
router.post('/clients/:id/notes', authenticate, requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.id;
    const { note } = req.body;
    const adminId = req.user!.userId;
    
    if (!note || note.trim() === '') {
      return res.status(400).json({ error: 'Note cannot be empty' });
    }
    
    const { rows: [newNote] } = await db.query(
      `INSERT INTO client_notes (client_id, author_id, note, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [clientId, adminId, note]
    );
    
    // Get author name
    const { rows: [author] } = await db.query(
      'SELECT name FROM users WHERE id = $1',
      [adminId]
    );
    
    res.status(201).json({
      ...newNote,
      author_name: author?.name || 'Admin'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// Delete client note
router.delete('/notes/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM client_notes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Get all subscriptions with analytics (for admin only)
router.get('/subscriptions', authenticate, requireAdmin, async (req, res) => {
  try {
    // Get all practices with subscription data
    const { rows: subscriptions } = await db.query(`
      SELECT 
        u.id,
        u.name,
        u.email,
        p.name as practice_name,
        p.subscription_status,
        p.stripe_customer_id,
        CASE 
          WHEN p.subscription_status = 'active' THEN 199
          ELSE 0
        END as amount,
        NOW() as current_period_start,
        NOW() + INTERVAL '30 days' as current_period_end,
        COALESCE(p.total_paid, 0) as total_paid,
        p.last_payment_date,
        p.last_payment_amount
      FROM users u
      LEFT JOIN practices p ON u.practice_id = p.id
      WHERE u.is_admin = FALSE
      ORDER BY u.created_at DESC
    `);

    // Calculate stats
    const activeSubs = subscriptions.filter((s: any) => s.subscription_status === 'active');
    const totalActive = activeSubs.length;
    const mrr = activeSubs.reduce((sum: number, s: any) => sum + (s.amount || 0), 0);
    const arr = mrr * 12;
    const averageRevenuePerUser = totalActive > 0 ? mrr / totalActive : 0;
    const totalInactive = subscriptions.filter((s: any) => s.subscription_status === 'inactive' || s.subscription_status === 'cancelled').length;
    const totalTrialing = subscriptions.filter((s: any) => s.subscription_status === 'trialing').length;

    res.json({
      subscriptions,
      stats: {
        total_active: totalActive,
        total_inactive: totalInactive,
        total_trialing: totalTrialing,
        monthly_recurring_revenue: mrr,
        annual_recurring_revenue: arr,
        average_revenue_per_user: averageRevenuePerUser,
        churn_rate: 0
      }
    });
  } catch (error) {
    console.error('Admin subscriptions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get analytics data for admin dashboard
router.get('/analytics', authenticate, requireAdmin, async (req, res) => {
  try {
    // Get total revenue from payments table
    const { rows: [revenue] } = await db.query(`
      SELECT COALESCE(SUM(amount_paid), 0) as total
      FROM payments
    `);
    
    // Get active practices count
    const { rows: [activePractices] } = await db.query(`
      SELECT COUNT(*) as count FROM practices WHERE subscription_status = 'active'
    `);
    
    // Get total appeals across all practices
    const { rows: [appeals] } = await db.query(`
      SELECT COUNT(*) as count FROM appeals
    `);
    
    // Get overall success rate
    const { rows: [successRate] } = await db.query(`
      SELECT 
        ROUND(
          COUNT(CASE WHEN c.status = 'won' THEN 1 END)::numeric / 
          NULLIF(COUNT(CASE WHEN c.status IN ('won', 'lost') THEN 1 END), 0) * 100, 
          1
        ) as rate
      FROM claims c
    `);
    
    // Get total clients count
    const { rows: [totalClients] } = await db.query(`
      SELECT COUNT(*) as count FROM users WHERE is_admin = FALSE
    `);
    
    // Calculate monthly growth
    const { rows: [growth] } = await db.query(`
      SELECT 
        ROUND(
          (COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END)::numeric / 
           NULLIF(COUNT(CASE WHEN created_at > NOW() - INTERVAL '60 days' THEN 1 END), 0) - 1) * 100,
          1
        ) as rate
      FROM users
      WHERE is_admin = FALSE
    `);
    
    res.json({
      totalRevenue: parseFloat(revenue?.total) || 0,
      activePractices: parseInt(activePractices?.count) || 0,
      totalAppeals: parseInt(appeals?.count) || 0,
      successRate: parseFloat(successRate?.rate) || 0,
      totalClients: parseInt(totalClients?.count) || 0,
      monthlyGrowth: parseFloat(growth?.rate) || 0
    });
  } catch (error) {
    console.error('Admin analytics error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual subscription override
router.post('/subscriptions/:id/override', authenticate, requireAdmin, async (req, res) => {
  try {
    const practiceId = req.params.id;
    const { status, reason } = req.body;
    const adminId = req.user!.userId;
    
    // Get current status
    const { rows: [practice] } = await db.query(
      'SELECT subscription_status FROM practices WHERE id = $1',
      [practiceId]
    );
    
    if (!practice) {
      return res.status(404).json({ error: 'Practice not found' });
    }
    
    const oldStatus = practice.subscription_status;
    
    // Update status
    await db.query(
      `UPDATE practices 
       SET subscription_status = $1,
           subscription_override_reason = $2,
           subscription_override_by = $3,
           subscription_override_at = NOW()
       WHERE id = $4`,
      [status, reason, adminId, practiceId]
    );
    
    // Log history
    await db.query(
      `INSERT INTO subscription_history (practice_id, old_status, new_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [practiceId, oldStatus, status, reason, adminId]
    );
    
    res.json({ success: true, message: `Subscription status changed to ${status}` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to override subscription' });
  }
});

// Get subscription history
router.get('/subscriptions/:id/history', authenticate, requireAdmin, async (req, res) => {
  try {
    const practiceId = req.params.id;
    
    const { rows } = await db.query(`
      SELECT sh.*, u.name as changed_by_name
      FROM subscription_history sh
      LEFT JOIN users u ON sh.changed_by = u.id
      WHERE sh.practice_id = $1
      ORDER BY sh.created_at DESC
    `, [practiceId]);
    
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get admin settings
router.get('/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json({
      siteName: 'DentalAppeal',
      supportEmail: 'support@dentalappeal.claims',
      defaultPlanPrice: 199,
      trialDays: 14,
      maintenanceMode: false,
      enableEmailNotifications: true,
      enableWeeklyDigest: true
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update admin settings
router.put('/settings', authenticate, requireAdmin, async (req, res) => {
  try {
    const { 
      siteName, 
      supportEmail, 
      defaultPlanPrice, 
      trialDays, 
      maintenanceMode,
      enableEmailNotifications,
      enableWeeklyDigest 
    } = req.body;
    
    res.json({ 
      message: 'Settings saved successfully',
      settings: {
        siteName,
        supportEmail,
        defaultPlanPrice,
        trialDays,
        maintenanceMode,
        enableEmailNotifications,
        enableWeeklyDigest
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
