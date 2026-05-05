import { Request, Response, NextFunction } from 'express';

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get the user ID from the request (set by authenticate middleware)
    const userId = (req as any).user?.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized - Please log in' });
    }

    // Import db dynamically to avoid circular dependencies
    const { db } = await import('../db');
    
    // Check if user is an admin
    const { rows } = await db.query(
      'SELECT is_admin FROM users WHERE id = $1',
      [userId]
    );

    if (!rows[0]?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // User is admin, proceed to the next function
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
