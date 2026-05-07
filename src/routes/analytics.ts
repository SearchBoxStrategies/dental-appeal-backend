import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

// Get analytics report
router.get('/report', authenticate, async (req, res) => {
  try {
    const userId = req.user!.userId;
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
    
    res.json({
      period,
      totalClaims: parseInt(stats.total_claims) || 0,
      totalAppeals: parseInt(stats.total_appeals) || 0,
      wonAppeals: parseInt(stats.won_appeals) || 0,
      lostAppeals: parseInt(stats.lost_appeals) || 0,
      pendingAppeals: parseInt(stats.pending_appeals) || 0,
      successRate,
      amountRecovered: parseFloat(stats.amount_recovered) || 0,
      timeSaved
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

export default router;
