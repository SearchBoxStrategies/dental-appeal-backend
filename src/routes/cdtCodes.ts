import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/', authenticate, async (req, res) => {
  try {
    // Remove 'full_descriptor' - it doesn't exist in your table
    const { rows } = await db.query(
      'SELECT code, category, description FROM cdt_codes ORDER BY category, code'
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
