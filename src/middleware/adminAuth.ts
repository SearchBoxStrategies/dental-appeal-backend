import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - Please log in' });
    }

    const { rows } = await db.query(
      'SELECT is_admin FROM users WHERE id = $1',
      [userId]
    );

    if (!rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
