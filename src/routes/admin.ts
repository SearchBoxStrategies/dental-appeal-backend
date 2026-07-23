import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

// ============================================
// CLIENT MANAGEMENT
// ============================================

// Get all active clients (for admin only)
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
      WHERE u.is_admin = FALSE AND u.deleted_at IS NULL
      ORDER BY u.created_at DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error('Admin clients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get deleted clients (for admin to view and restore)
router.get('/clients/deleted', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        u.id,
        u.email,
        u.name,
        u.created_at,
        u.deleted_at,
        p.name as practice_name,
        p.subscription_status,
        (SELECT COUNT(*) FROM claims WHERE created_by = u.id) as total_claims
      FROM users u
      LEFT JOIN practices p ON u.practice_id = p.id
      WHERE u.is_admin = FALSE AND u.deleted_at IS NOT NULL
      ORDER BY u.deleted_at DESC
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Get deleted clients error:', error);
    res.status(500).json({ error: 'Failed to fetch deleted clients' });
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
        u.deleted_at,
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

    // Get payment/summary stats
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

// Soft delete a client (mark as deleted but keep data)
router.delete('/clients/:id', authenticate, requireAdmin, async (req, res) => {
  const clientId = req.params.id;
  
  try {
    // Check if client exists and is not already deleted
    const { rows: [client] } = await db.query(
      'SELECT id, email, practice_id FROM users WHERE id = $1 AND is_admin = FALSE AND deleted_at IS NULL',
      [clientId]
    );
    
    if (!client) {
      return res.status(404).json({ error: 'Client not found or already deleted' });
    }

    // Soft delete - mark as deleted
    await db.query(
      'UPDATE users SET deleted_at = NOW() WHERE id = $1',
      [clientId]
    );
    
    if (client.practice_id) {
      await db.query(
        'UPDATE practices SET subscription_status = $1, deleted_at = NOW() WHERE id = $2',
        ['deleted', client.practice_id]
      );
    }
    
    res.json({ 
      success: true, 
      message: 'Client deactivated and marked as deleted successfully' 
    });
  } catch (error) {
    console.error('Soft delete client error:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// Restore a soft-deleted client
router.post('/clients/:id/restore', authenticate, requireAdmin, async (req, res) => {
  const clientId = req.params.id;
  
  try {
    // Check if client exists and is deleted
    const { rows: [client] } = await db.query(
      'SELECT id, practice_id FROM users WHERE id = $1 AND deleted_at IS NOT NULL',
      [clientId]
    );
    
    if (!client) {
      return res.status(404).json({ error: 'Client not found or not deleted' });
    }
    
    // Restore - remove deleted_at
    await db.query(
      'UPDATE users SET deleted_at = NULL WHERE id = $1',
      [clientId]
    );
    
    if (client.practice_id) {
      await db.query(
        'UPDATE practices SET subscription_status = $1, deleted_at = NULL WHERE id = $2',
        ['inactive', client.practice_id]
      );
    }
    
    res.json({ success: true, message: 'Client restored successfully' });
  } catch (error) {
    console.error('Restore client error:', error);
    res.status(500).json({ error: 'Failed to restore client' });
  }
});

// ============================================
// NEW: HARD DELETE - Permanently delete client
// ============================================
router.delete('/clients/:id/permanent', authenticate, requireAdmin, async (req, res) => {
  const clientId = req.params.id;
  const client = await db.connect();
  
  try {
    const { confirm, deletePayments, reason } = req.body;
    
    // Safety: Require explicit confirmation
    if (confirm !== 'DELETE_PERMANENTLY') {
      return res.status(400).json({ 
        error: 'Confirmation required',
        message: 'Please confirm with "DELETE_PERMANENTLY"'
      });
    }
    
    // Check if client exists
    const { rows: [user] } = await db.query(
      `SELECT u.*, p.id as practice_id, p.name as practice_name, p.subscription_status, p.stripe_customer_id
       FROM users u
       LEFT JOIN practices p ON u.practice_id = p.id
       WHERE u.id = $1`,
      [clientId]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    // Check if this is an admin account
    if (user.is_admin) {
      return res.status(403).json({ error: 'Cannot delete admin accounts' });
    }
    
    await client.query('BEGIN');
    
    // Get counts before deletion for audit
    const counts = await client.query(
      `
      SELECT 
        (SELECT COUNT(*) FROM claims WHERE created_by = $1) as claims,
        (SELECT COUNT(*) FROM appeals a JOIN claims c ON a.claim_id = c.id WHERE c.created_by = $1) as appeals,
        (SELECT COUNT(*) FROM client_notes WHERE client_id = $1) as notes,
        (SELECT COUNT(*) FROM payments WHERE user_id = $1) as payments,
        (SELECT COUNT(*) FROM subscription_history WHERE practice_id = $2) as sub_history,
        (SELECT COUNT(*) FROM documents WHERE user_id = $1) as documents,
        (SELECT COUNT(*) FROM affiliate_referrals WHERE practice_id = $2) as referrals
      `,
      [clientId, user.practice_id]
    );
    
    const dataCounts = counts.rows[0];
    
    // 1. Delete client notes
    const { rowCount: notesDeleted } = await client.query(
      'DELETE FROM client_notes WHERE client_id = $1',
      [clientId]
    );
    
    // 2. Delete documents
    const { rowCount: documentsDeleted } = await client.query(
      'DELETE FROM documents WHERE user_id = $1',
      [clientId]
    );
    
    // 3. Delete appeals (through claims)
    const { rowCount: appealsDeleted } = await client.query(
      'DELETE FROM appeals WHERE claim_id IN (SELECT id FROM claims WHERE created_by = $1)',
      [clientId]
    );
    
    // 4. Delete claims
    const { rowCount: claimsDeleted } = await client.query(
      'DELETE FROM claims WHERE created_by = $1',
      [clientId]
    );
    
    // 5. Delete subscription history
    const { rowCount: subHistoryDeleted } = await client.query(
      'DELETE FROM subscription_history WHERE practice_id = $1',
      [user.practice_id]
    );
    
    // 6. Handle payments
    let paymentsDeleted = 0;
    if (deletePayments === true) {
      const result = await client.query(
        'DELETE FROM payments WHERE user_id = $1',
        [clientId]
      );
      paymentsDeleted = result.rowCount;
    } else {
      // Anonymize payments instead of deleting
      await client.query(
        `UPDATE payments 
         SET user_id = NULL, 
             user_email = 'deleted@removed.com',
             user_name = 'Deleted User',
             deleted_at = NOW()
         WHERE user_id = $1`,
        [clientId]
      );
    }
    
    // 7. Delete any affiliate referrals
    if (user.practice_id) {
      await client.query(
        'DELETE FROM affiliate_referrals WHERE practice_id = $1',
        [user.practice_id]
      );
    }
    
    // 8. Delete the user
    const { rowCount: userDeleted } = await client.query(
      'DELETE FROM users WHERE id = $1',
      [clientId]
    );
    
    // 9. Delete the practice
    let practiceDeleted = 0;
    if (user.practice_id) {
      const result = await client.query(
        'DELETE FROM practices WHERE id = $1',
        [user.practice_id]
      );
      practiceDeleted = result.rowCount;
    }
    
    // 10. Record audit log
    await client.query(
      `INSERT INTO admin_audit_logs (
        admin_id, 
        action, 
        table_name, 
        record_id, 
        old_data, 
        reason,
        ip_address,
        user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.user!.userId,
        'HARD_DELETE_CLIENT',
        'users',
        clientId,
        JSON.stringify({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            practice_id: user.practice_id,
            practice_name: user.practice_name
          },
          counts: dataCounts,
          deleted_at: new Date().toISOString()
        }),
        reason || 'Permanent deletion requested by admin',
        req.ip || req.headers['x-forwarded-for'],
        req.headers['user-agent']
      ]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: `Client "${user.name}" and all associated data have been permanently deleted`,
      deleted: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          practice_name: user.practice_name
        },
        counts: {
          claims: claimsDeleted,
          appeals: appealsDeleted,
          notes: notesDeleted,
          documents: documentsDeleted,
          payments: deletePayments ? paymentsDeleted : 'Anonymized',
          subscription_history: subHistoryDeleted,
          practice: practiceDeleted,
          referrals: dataCounts.referrals
        }
      }
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error hard deleting client:', error);
    res.status(500).json({ 
      error: 'Failed to permanently delete client',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  } finally {
    client.release();
  }
});

// ============================================
// NEW: PREVIEW DELETION IMPACT
// ============================================
router.get('/clients/:id/delete-preview', authenticate, requireAdmin, async (req, res) => {
  try {
    const clientId = req.params.id;
    
    const { rows: [user] } = await db.query(
      `SELECT u.*, p.name as practice_name, p.subscription_status
       FROM users u
       LEFT JOIN practices p ON u.practice_id = p.id
       WHERE u.id = $1 AND u.is_admin = FALSE`,
      [clientId]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    const counts = await db.query(
      `
      SELECT 
        (SELECT COUNT(*) FROM claims WHERE created_by = $1) as claims,
        (SELECT COUNT(*) FROM appeals a JOIN claims c ON a.claim_id = c.id WHERE c.created_by = $1) as appeals,
        (SELECT COUNT(*) FROM client_notes WHERE client_id = $1) as notes,
        (SELECT COUNT(*) FROM payments WHERE user_id = $1) as payments,
        (SELECT COUNT(*) FROM subscription_history WHERE practice_id = $2) as sub_history,
        (SELECT COUNT(*) FROM documents WHERE user_id = $1) as documents,
        (SELECT COUNT(*) FROM affiliate_referrals WHERE practice_id = $2) as referrals
      `,
      [clientId, user.practice_id]
    );
    
    // Get samples of data to be deleted
    const { rows: sampleClaims } = await db.query(
      'SELECT id, patient_name, status, created_at FROM claims WHERE created_by = $1 LIMIT 5',
      [clientId]
    );
    
    const { rows: samplePayments } = await db.query(
      'SELECT id, amount_paid, status, created_at FROM payments WHERE user_id = $1 LIMIT 5',
      [clientId]
    );
    
    const totalRecords = Object.values(counts.rows[0]).reduce((a, b) => a + parseInt(b || '0'), 0);
    
    res.json({
      success: true,
      preview: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          practice_name: user.practice_name,
          subscription_status: user.subscription_status,
          created_at: user.created_at
        },
        deletion_impact: counts.rows[0],
        samples: {
          claims: sampleClaims,
          payments: samplePayments
        },
        summary: {
          total_records: totalRecords,
          has_active_subscription: user.subscription_status === 'active' || user.subscription_status === 'trialing',
          has_payments: parseInt(counts.rows[0].payments) > 0,
          has_claims: parseInt(counts.rows[0].claims) > 0
        }
      }
    });
  } catch (error) {
    console.error('❌ Error previewing deletion:', error);
    res.status(500).json({ error: 'Failed to preview deletion' });
  }
});

// ============================================
// NEW: BULK HARD DELETE
// ============================================
router.post('/clients/bulk-delete', authenticate, requireAdmin, async (req, res) => {
  const client = await db.connect();
  
  try {
    const { clientIds, confirm, deletePayments, reason } = req.body;
    
    if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
      return res.status(400).json({ error: 'Client IDs required' });
    }
    
    if (confirm !== 'DELETE_PERMANENTLY') {
      return res.status(400).json({ 
        error: 'Confirmation required',
        message: 'Please confirm with "DELETE_PERMANENTLY"'
      });
    }
    
    // Get client details
    const { rows: users } = await db.query(
      'SELECT id, name, email FROM users WHERE id = ANY($1) AND is_admin = FALSE',
      [clientIds]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'No valid clients found' });
    }
    
    await client.query('BEGIN');
    
    let totalDeleted = {
      users: 0,
      practices: 0,
      claims: 0,
      appeals: 0,
      payments: 0,
      notes: 0,
      documents: 0,
      sub_history: 0,
      referrals: 0
    };
    
    for (const user of users) {
      // Get practice id
      const { rows: [practice] } = await db.query(
        'SELECT id FROM practices WHERE id = (SELECT practice_id FROM users WHERE id = $1)',
        [user.id]
      );
      
      const practiceId = practice?.id;
      
      // Delete associated data
      await client.query('DELETE FROM client_notes WHERE client_id = $1', [user.id]);
      await client.query('DELETE FROM documents WHERE user_id = $1', [user.id]);
      await client.query('DELETE FROM appeals WHERE claim_id IN (SELECT id FROM claims WHERE created_by = $1)', [user.id]);
      
      const claimsResult = await client.query('DELETE FROM claims WHERE created_by = $1', [user.id]);
      totalDeleted.claims += claimsResult.rowCount;
      
      if (deletePayments) {
        const paymentsResult = await client.query('DELETE FROM payments WHERE user_id = $1', [user.id]);
        totalDeleted.payments += paymentsResult.rowCount;
      } else {
        await client.query(
          'UPDATE payments SET user_id = NULL, user_email = $1, user_name = $2, deleted_at = NOW() WHERE user_id = $3',
          ['deleted@removed.com', 'Deleted User', user.id]
        );
      }
      
      if (practiceId) {
        await client.query('DELETE FROM subscription_history WHERE practice_id = $1', [practiceId]);
        const referralsResult = await client.query('DELETE FROM affiliate_referrals WHERE practice_id = $1', [practiceId]);
        totalDeleted.referrals += referralsResult.rowCount;
        const practiceResult = await client.query('DELETE FROM practices WHERE id = $1', [practiceId]);
        totalDeleted.practices += practiceResult.rowCount;
      }
      
      const userResult = await client.query('DELETE FROM users WHERE id = $1', [user.id]);
      totalDeleted.users += userResult.rowCount;
    }
    
    // Record audit log (bulk)
    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, table_name, record_id, old_data, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.user!.userId,
        'BULK_HARD_DELETE',
        'users',
        JSON.stringify(clientIds),
        JSON.stringify({ 
          users: users.map(u => ({ id: u.id, name: u.name, email: u.email })),
          timestamp: new Date().toISOString()
        }),
        reason || 'Bulk deletion requested by admin'
      ]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: `${totalDeleted.users} clients permanently deleted`,
      deleted: totalDeleted,
      clients: users
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error bulk deleting clients:', error);
    res.status(500).json({ 
      error: 'Failed to bulk delete clients',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  } finally {
    client.release();
  }
});

// ============================================
// CLIENT NOTES
// ============================================

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

// ============================================
// SUBSCRIPTION MANAGEMENT
// ============================================

// Get all subscriptions with analytics
router.get('/subscriptions', authenticate, requireAdmin, async (req, res) => {
  try {
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
      WHERE u.is_admin = FALSE AND u.deleted_at IS NULL
      ORDER BY u.created_at DESC
    `);

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

// Manual subscription override
router.post('/subscriptions/:id/override', authenticate, requireAdmin, async (req, res) => {
  try {
    const practiceId = req.params.id;
    const { status, reason } = req.body;
    const adminId = req.user!.userId;
    
    const { rows: [practice] } = await db.query(
      'SELECT subscription_status FROM practices WHERE id = $1 AND deleted_at IS NULL',
      [practiceId]
    );
    
    if (!practice) {
      return res.status(404).json({ error: 'Practice not found' });
    }
    
    const oldStatus = practice.subscription_status;
    
    await db.query(
      `UPDATE practices 
       SET subscription_status = $1,
           subscription_override_reason = $2,
           subscription_override_by = $3,
           subscription_override_at = NOW()
       WHERE id = $4`,
      [status, reason, adminId, practiceId]
    );
    
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

// ============================================
// PAYMENT MANAGEMENT
// ============================================

// Get all payments across all clients
router.get('/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        p.id,
        p.amount_paid,
        p.payment_method,
        p.status,
        p.created_at,
        p.stripe_payment_intent_id,
        u.id as user_id,
        u.email,
        u.name,
        pr.name as practice_name,
        pr.stripe_customer_id
      FROM payments p
      JOIN users u ON p.user_id = u.id
      JOIN practices pr ON u.practice_id = pr.id
      WHERE u.deleted_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT 100
    `);
    
    const { rows: [totals] } = await db.query(`
      SELECT 
        COALESCE(SUM(amount_paid), 0) as total_revenue,
        COUNT(*) as total_transactions,
        COUNT(DISTINCT user_id) as unique_customers
      FROM payments
      WHERE status = 'succeeded'
    `);
    
    res.json({ 
      payments: rows, 
      totals: {
        total_revenue: parseFloat(totals?.total_revenue) || 0,
        total_transactions: parseInt(totals?.total_transactions) || 0,
        unique_customers: parseInt(totals?.unique_customers) || 0
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Get payment summary for dashboard
router.get('/payments/summary', authenticate, requireAdmin, async (req, res) => {
  try {
    const thisMonthResult = await db.query(`
      SELECT 
        COALESCE(SUM(amount_paid), 0) as total,
        COUNT(*) as count
      FROM payments
      WHERE status = 'succeeded'
        AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())
    `);
    
    const lastMonthResult = await db.query(`
      SELECT 
        COALESCE(SUM(amount_paid), 0) as total,
        COUNT(*) as count
      FROM payments
      WHERE status = 'succeeded'
        AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')
    `);
    
    const thisMonthTotal = parseFloat(thisMonthResult.rows[0]?.total) || 0;
    const lastMonthTotal = parseFloat(lastMonthResult.rows[0]?.total) || 0;
    const thisMonthCount = parseInt(thisMonthResult.rows[0]?.count) || 0;
    const lastMonthCount = parseInt(lastMonthResult.rows[0]?.count) || 0;
    
    let percentChange = 0;
    if (lastMonthTotal > 0) {
      percentChange = ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100;
    }
    
    res.json({
      thisMonth: {
        total: thisMonthTotal,
        count: thisMonthCount
      },
      lastMonth: {
        total: lastMonthTotal,
        count: lastMonthCount
      },
      percentChange: Number(percentChange.toFixed(1))
    });
  } catch (error) {
    console.error('Payment summary error:', error);
    res.status(500).json({ error: 'Failed to fetch payment summary' });
  }
});

// ============================================
// ANALYTICS
// ============================================

// Get analytics data for admin dashboard
router.get('/analytics', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows: [revenue] } = await db.query(`
      SELECT COALESCE(SUM(amount_paid), 0) as total
      FROM payments
    `);
    
    const { rows: [activePractices] } = await db.query(`
      SELECT COUNT(*) as count FROM practices WHERE subscription_status = 'active'
    `);
    
    const { rows: [appeals] } = await db.query(`
      SELECT COUNT(*) as count FROM appeals
    `);
    
    const { rows: [successRate] } = await db.query(`
      SELECT 
        ROUND(
          COUNT(CASE WHEN c.status = 'won' THEN 1 END)::numeric / 
          NULLIF(COUNT(CASE WHEN c.status IN ('won', 'lost') THEN 1 END), 0) * 100, 
          1
        ) as rate
      FROM claims c
    `);
    
    const { rows: [totalClients] } = await db.query(`
      SELECT COUNT(*) as count FROM users WHERE is_admin = FALSE AND deleted_at IS NULL
    `);
    
    const { rows: [growth] } = await db.query(`
      SELECT 
        ROUND(
          (COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END)::numeric / 
           NULLIF(COUNT(CASE WHEN created_at > NOW() - INTERVAL '60 days' THEN 1 END), 0) - 1) * 100,
          1
        ) as rate
      FROM users
      WHERE is_admin = FALSE AND deleted_at IS NULL
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

// ============================================
// SETTINGS
// ============================================

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

// ============================================
// AFFILIATE MANAGEMENT
// ============================================

// Get all active affiliates (admin only)
router.get('/affiliates', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        a.*,
        u.email as user_email,
        u.name as user_name,
        COUNT(DISTINCT ar.id) as referral_count,
        COUNT(DISTINCT ac.id) as commission_count
      FROM affiliates a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN affiliate_referrals ar ON a.id = ar.affiliate_id AND ar.deleted_at IS NULL
      LEFT JOIN affiliate_commissions ac ON ar.id = ac.referral_id AND ac.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
      GROUP BY a.id, u.email, u.name
      ORDER BY a.created_at DESC
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch affiliates:', error);
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
});

// Get deleted affiliates (admin only)
router.get('/affiliates/deleted', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT 
        a.*,
        u.email as user_email,
        u.name as user_name,
        COUNT(DISTINCT ar.id) as referral_count
      FROM affiliates a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN affiliate_referrals ar ON a.id = ar.affiliate_id AND ar.deleted_at IS NULL
      WHERE a.deleted_at IS NOT NULL
      GROUP BY a.id, u.email, u.name
      ORDER BY a.deleted_at DESC
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch deleted affiliates:', error);
    res.status(500).json({ error: 'Failed to fetch deleted affiliates' });
  }
});

// Soft delete an affiliate (admin only)
router.delete('/affiliates/:id', authenticate, requireAdmin, async (req, res) => {
  const affiliateId = req.params.id;
  
  try {
    // Check if affiliate exists and is not already deleted
    const { rows: [affiliate] } = await db.query(
      'SELECT id, email, full_name FROM affiliates WHERE id = $1 AND deleted_at IS NULL',
      [affiliateId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found or already deleted' });
    }

    // Start transaction
    await db.query('BEGIN');
    
    // Soft delete the affiliate
    await db.query(
      'UPDATE affiliates SET deleted_at = NOW() WHERE id = $1',
      [affiliateId]
    );
    
    // Soft delete associated referrals (optional)
    await db.query(
      'UPDATE affiliate_referrals SET deleted_at = NOW() WHERE affiliate_id = $1 AND deleted_at IS NULL',
      [affiliateId]
    );
    
    // Soft delete associated commissions (optional)
    await db.query(
      'UPDATE affiliate_commissions SET deleted_at = NOW() WHERE referral_id IN (SELECT id FROM affiliate_referrals WHERE affiliate_id = $1) AND deleted_at IS NULL',
      [affiliateId]
    );
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true, 
      message: `Affiliate ${affiliate.full_name} has been deactivated and marked as deleted.` 
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Soft delete affiliate error:', error);
    res.status(500).json({ error: 'Failed to delete affiliate' });
  }
});

// Restore a soft-deleted affiliate (admin only)
router.post('/affiliates/:id/restore', authenticate, requireAdmin, async (req, res) => {
  const affiliateId = req.params.id;
  
  try {
    // Check if affiliate exists and is deleted
    const { rows: [affiliate] } = await db.query(
      'SELECT id, email, full_name FROM affiliates WHERE id = $1 AND deleted_at IS NOT NULL',
      [affiliateId]
    );
    
    if (!affiliate) {
      return res.status(404).json({ error: 'Affiliate not found or not deleted' });
    }
    
    // Start transaction
    await db.query('BEGIN');
    
    // Restore the affiliate
    await db.query(
      'UPDATE affiliates SET deleted_at = NULL WHERE id = $1',
      [affiliateId]
    );
    
    // Restore associated referrals (optional)
    await db.query(
      'UPDATE affiliate_referrals SET deleted_at = NULL WHERE affiliate_id = $1 AND deleted_at IS NOT NULL',
      [affiliateId]
    );
    
    // Restore associated commissions (optional)
    await db.query(
      'UPDATE affiliate_commissions SET deleted_at = NULL WHERE referral_id IN (SELECT id FROM affiliate_referrals WHERE affiliate_id = $1) AND deleted_at IS NOT NULL',
      [affiliateId]
    );
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true, 
      message: `Affiliate ${affiliate.full_name} has been restored successfully.` 
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('Restore affiliate error:', error);
    res.status(500).json({ error: 'Failed to restore affiliate' });
  }
});

// ============================================
// AFFILIATE AUTO-PAYOUT ENDPOINTS
// ============================================

router.post('/run-payout', authenticate, requireAdmin, async (req, res) => {
  try {
    console.log('💰 Affiliate payout triggered by admin:', req.user?.email);
    
    const { processAutoPayouts } = await import('../jobs/autoPayout');
    await processAutoPayouts();
    
    res.json({ 
      success: true, 
      message: 'Affiliate payout process completed successfully' 
    });
  } catch (error) {
    console.error('Payout error:', error);
    res.status(500).json({ 
      error: 'Payout process failed', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

router.post('/cron/payout', async (req, res) => {
  const cronSecret = req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET_KEY;
  
  if (!expectedSecret) {
    console.error('CRON_SECRET_KEY not set in environment variables');
    return res.status(500).json({ error: 'Cron secret not configured' });
  }
  
  if (cronSecret !== expectedSecret) {
    console.error('Unauthorized cron attempt - invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    console.log('💰 Cron-triggered affiliate payout');
    const { processAutoPayouts } = await import('../jobs/autoPayout');
    await processAutoPayouts();
    
    res.json({ success: true, message: 'Payout completed successfully' });
  } catch (error) {
    console.error('Cron payout error:', error);
    res.status(500).json({ 
      error: 'Payout failed', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;
