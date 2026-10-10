import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

// A claim counts as recovered once it is won or paid. When the practice hasn't recorded what
// the insurer actually paid, the denied amount is used and the figure is flagged as estimated.
const RECOVERED_AMOUNT = `COALESCE(amount_recovered, amount_denied, 0)`;
const IS_RECOVERED = `status IN ('won', 'paid')`;
const IS_RESOLVED = `status IN ('won', 'lost', 'paid')`;

// Recovered-dollars summary for the practice dashboard
router.get('/recovery', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;

    const { rows: [totals] } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_RECOVERED} THEN ${RECOVERED_AMOUNT} END), 0) AS recovered_all_time,
        COALESCE(SUM(CASE WHEN ${IS_RECOVERED} AND resolved_at >= date_trunc('month', NOW())
                          THEN ${RECOVERED_AMOUNT} END), 0) AS recovered_this_month,
        COUNT(CASE WHEN ${IS_RECOVERED} THEN 1 END)::int AS won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END)::int AS lost,
        COUNT(CASE WHEN ${IS_RECOVERED} AND amount_recovered IS NULL THEN 1 END)::int AS estimated_count,
        COUNT(CASE WHEN status IN ('appealed', 'under_review') THEN 1 END)::int AS pending_count,
        COALESCE(SUM(CASE WHEN status IN ('appealed', 'under_review') THEN amount_denied END), 0) AS pending_value
      FROM claims
      WHERE practice_id = $1
    `, [practiceId]);

    const { rows: monthly } = await db.query(`
      SELECT
        to_char(date_trunc('month', resolved_at), 'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN ${IS_RECOVERED} THEN ${RECOVERED_AMOUNT} END), 0) AS recovered,
        COUNT(CASE WHEN ${IS_RECOVERED} THEN 1 END)::int AS won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END)::int AS lost
      FROM claims
      WHERE practice_id = $1
        AND ${IS_RESOLVED}
        AND resolved_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
      GROUP BY 1
      ORDER BY 1
    `, [practiceId]);

    const { rows: byInsurer } = await db.query(`
      SELECT
        insurance_company,
        COUNT(CASE WHEN ${IS_RECOVERED} THEN 1 END)::int AS won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END)::int AS lost,
        COALESCE(SUM(CASE WHEN ${IS_RECOVERED} THEN ${RECOVERED_AMOUNT} END), 0) AS recovered
      FROM claims
      WHERE practice_id = $1 AND ${IS_RESOLVED}
      GROUP BY insurance_company
      ORDER BY recovered DESC, won DESC
      LIMIT 5
    `, [practiceId]);

    const { rows: [practice] } = await db.query(
      'SELECT total_paid FROM practices WHERE id = $1',
      [practiceId]
    );

    const recoveredAllTime = parseFloat(totals.recovered_all_time) || 0;
    const totalPaid = parseFloat(practice?.total_paid) || 0;
    const resolved = totals.won + totals.lost;

    res.json({
      recoveredAllTime,
      recoveredThisMonth: parseFloat(totals.recovered_this_month) || 0,
      won: totals.won,
      lost: totals.lost,
      winRate: resolved > 0 ? Math.round((totals.won / resolved) * 100) : null,
      estimatedCount: totals.estimated_count,
      pendingCount: totals.pending_count,
      pendingValue: parseFloat(totals.pending_value) || 0,
      totalPaid,
      // Recovered dollars per dollar paid for DentalAppeal; null until the practice has paid.
      roiMultiple: totalPaid > 0 ? Math.round((recoveredAllTime / totalPaid) * 10) / 10 : null,
      monthly: monthly.map(m => ({
        month: m.month,
        recovered: parseFloat(m.recovered) || 0,
        won: m.won,
        lost: m.lost,
      })),
      byInsurer: byInsurer.map(i => ({
        insurer: i.insurance_company,
        won: i.won,
        lost: i.lost,
        winRate: i.won + i.lost > 0 ? Math.round((i.won / (i.won + i.lost)) * 100) : null,
        recovered: parseFloat(i.recovered) || 0,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
        COUNT(CASE WHEN EXISTS (SELECT 1 FROM appeals a WHERE a.claim_id = c.id) THEN 1 END) as total_appeals,
        COUNT(CASE WHEN c.status IN ('won', 'paid') THEN 1 END) as won_appeals,
        COUNT(CASE WHEN c.status = 'lost' THEN 1 END) as lost_appeals,
        COUNT(CASE WHEN c.status IN ('appealed', 'under_review') THEN 1 END) as pending_appeals,
        COALESCE(SUM(CASE WHEN c.status IN ('won', 'paid')
                          THEN COALESCE(c.amount_recovered, c.amount_denied, 0) END), 0) as amount_recovered
      FROM claims c
      WHERE c.practice_id = $1
        AND c.created_at > NOW() - $2::interval
    `, [practiceId, interval]);

    const totalResolved = (parseInt(stats.won_appeals) || 0) + (parseInt(stats.lost_appeals) || 0);
    const successRate = totalResolved > 0 ? Math.round((parseInt(stats.won_appeals) / totalResolved) * 100) : 0;

    // Calculate time saved (estimate: 2 hours per appeal manually)
    const timeSaved = (parseInt(stats.total_appeals) || 0) * 2;

    // Get average response time
    const { rows: [avgResponse] } = await db.query(`
      SELECT ROUND(AVG(EXTRACT(DAY FROM (resolved_at - created_at)))) as avg_days
      FROM claims
      WHERE practice_id = $1 AND status IN ('won', 'lost', 'paid') AND resolved_at IS NOT NULL
    `, [practiceId]);

    // Get top performing payer
    const { rows: [topPayer] } = await db.query(`
      SELECT
        insurance_company,
        COUNT(*) as total,
        ROUND(COUNT(CASE WHEN status IN ('won', 'paid') THEN 1 END)::numeric /
              NULLIF(COUNT(*), 0) * 100, 1) as success_rate
      FROM claims
      WHERE practice_id = $1 AND status IN ('won', 'lost', 'paid')
      GROUP BY insurance_company
      ORDER BY total DESC
      LIMIT 1
    `, [practiceId]);

    // No placeholder values: fields are null until the practice has real resolved claims.
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
      avgResponseDays: avgResponse?.avg_days != null ? Math.round(avgResponse.avg_days) : null,
      topPayer: topPayer?.insurance_company ?? null,
      topPayerSuccessRate: topPayer?.success_rate != null ? parseFloat(topPayer.success_rate) : null
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
        COUNT(CASE WHEN status IN ('won', 'paid') THEN 1 END) as won
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
        COUNT(CASE WHEN status IN ('won', 'paid') THEN 1 END) as won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as lost,
        COUNT(CASE WHEN status = 'appealed' THEN 1 END) as appealed,
        COALESCE(SUM(amount_denied), 0) as amount_denied_total,
        COALESCE(SUM(CASE WHEN status IN ('won', 'paid')
                          THEN COALESCE(amount_recovered, amount_denied, 0) END), 0) as amount_recovered
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
        COUNT(CASE WHEN status IN ('won', 'paid') THEN 1 END) as won,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as lost,
        ROUND(COUNT(CASE WHEN status IN ('won', 'paid') THEN 1 END)::numeric /
              NULLIF(COUNT(*), 0) * 100, 1) as success_rate,
        COALESCE(SUM(amount_denied), 0) as total_denied,
        COALESCE(SUM(CASE WHEN status IN ('won', 'paid')
                          THEN COALESCE(amount_recovered, amount_denied, 0) END), 0) as recovered
      FROM claims
      WHERE practice_id = $1 AND status IN ('won', 'lost', 'paid')
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
