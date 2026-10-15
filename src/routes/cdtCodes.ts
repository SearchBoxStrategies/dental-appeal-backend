import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, async (req, res) => {
  try {
    // Active codes only; retired codes stay in the table for older claims.
    const { rows } = await db.query(
      `SELECT code, category, description, COALESCE(system, 'CDT') AS system
       FROM cdt_codes WHERE COALESCE(is_active, true)
       ORDER BY category, code`
    );
    
    // Group by category for frontend
    const grouped: Record<string, typeof rows> = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }
    
    res.json(grouped);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
