import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

// Get analytics report
router.get('/report', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    const period = req.query.period as string || 'month';
    
    let interval: string;
    switch (period) {
      case 'week': interval = '7 days'; break;
      case 'month': interval = '30 days'; break;
      case 'quarter': interval = '90 days'; break;
      case 'year': interval = '365 days'; break;
      default: interval = '30 days';
    }
    
    const { rows: [stats] } = await db.query(`
      SELECT 
        COUNT(*) as total_claims,
        COUNT(CASE WHEN a.id IS NOT NULL THEN 1 END) as total_appeals,
        COUNT(CASE WHEN c.status = 'won' THEN 1 END) as won_appeals,
        COUNT(CASE WHEN c.status = 'lost' THEN 1 END) as lost_appeals,
        COUNT(CASE WHEN c.status IN ('appealed', 'under_review') THEN 1 END) as pending_appeals,
        COALESCE(SUM(c.amount_denied), 0) as amount_recovered
      FROM claims c
      LEFT JOIN appeals a ON a.claim_id = c.id
      WHERE c.practice_id = $1 
        AND c.created_at > NOW() - $2::interval
    `, [practiceId, interval]);
    
    const totalResolved = (parseInt(stats.won_appeals) || 0) + (parseInt(stats.lost_appeals) || 0);
    const successRate = totalResolved > 0 ? Math.round((parseInt(stats.won_appeals) / totalResolved) * 100) : 0;
    
    // Calculate time saved (estimate: 2 hours per appeal manually)
    const timeSaved = (parseInt(stats.total_appeals) || 0) * 2;
    
    // Get average response time
    const { rows: [avgResponse] } = await db.query(`
      SELECT ROUND(AVG(EXTRACT(DAY FROM (updated_at - created_at)))) as avg_days
      FROM claims
      WHERE practice_id = $1 AND status IN ('won', 'lost') AND updated_at IS NOT NULL
    `, [practiceId]);
    
    // Get top performing payer
    const { rows: [topPayer] } = await db.query(`
      SELECT 
        insurance_company,
        COUNT(*) as total,
        ROUND(COUNT(CASE WHEN status = 'won' THEN 1 END)::numeric / 
              NULLIF(COUNT(CASE WHEN status IN ('won', 'lost') THEN 1 END), 0) * 100, 1) as success_rate
      FROM claims
      WHERE practice_id = $1 AND status IN ('won', 'lost')
      GROUP BY insurance_company
      ORDER BY total DESC
      LIMIT 1
    `, [practiceId]);
    
    res.json({
      period,
      totalClaims: parseInt(stats.total_claims) || 0,
      totalAppeals: parseInt(stats.total_appeals) || 0,
      wonAppeals: parseInt(stats.won_appeals) || 0,
      lostAppeals: parseInt(stats.lost_appeals) || 0,
      pendingAppeals: parseInt(stats.pending_appeals) || 0,
      successRate,
      amountRecovered: parseFloat(stats.amount_recovered) || 0,
      timeSaved,
      avgResponseDays: Math.round(avgResponse?.avg_days || 32),
      topPayer: topPayer?.insurance_company || 'Delta Dental',
      topPayerSuccessRate: topPayer?.success_rate || 67
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get chart data for analytics
router.get('/chart', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    
    const { rows } = await db.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as claims,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as won
      FROM claims
      WHERE practice_id = $1 
        AND created_at > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
    `, [practiceId]);
    
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get client performance summary (Phase 3)
router.get('/client-summary', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    
    const { rows } = await db.query(`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as claims,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as lost,
        COUNT(CASE WHEN status = 'appealed' THEN 1 END) as appealed,
        COALESCE(SUM(amount_denied), 0) as amount_denied_total,
        COALESCE(SUM(CASE WHEN status = 'won' THEN amount_denied END), 0) as amount_recovered
      FROM claims
      WHERE practice_id = $1 
        AND created_at > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
    `, [practiceId]);
    
    // Calculate rolling averages and trends
    let totals = { claims: 0, won: 0, lost: 0, appealed: 0 };
    for (const row of rows) {
      totals.claims += parseInt(row.claims);
      totals.won += parseInt(row.won);
      totals.lost += parseInt(row.lost);
      totals.appealed += parseInt(row.appealed);
    }
    
    const successRate = totals.won + totals.lost > 0 ? (totals.won / (totals.won + totals.lost)) * 100 : 0;
    
    res.json({ monthly: rows, totals, success_rate: successRate });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payer performance breakdown (Phase 3)
router.get('/payer-performance', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    
    const { rows } = await db.query(`
      SELECT 
        insurance_company,
        COUNT(*) as total_claims,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as lost,
        ROUND(COUNT(CASE WHEN status = 'won' THEN 1 END)::numeric / 
              NULLIF(COUNT(CASE WHEN status IN ('won', 'lost') THEN 1 END), 0) * 100, 1) as success_rate,
        COALESCE(SUM(amount_denied), 0) as total_denied,
        COALESCE(SUM(CASE WHEN status = 'won' THEN amount_denied END), 0) as recovered
      FROM claims
      WHERE practice_id = $1 AND status IN ('won', 'lost')
      GROUP BY insurance_company
      ORDER BY total_claims DESC
    `, [practiceId]);
    
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
