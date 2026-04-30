import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export async function requireActiveSubscription(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { rows } = await db.query(
      'SELECT subscription_status FROM practices WHERE id = $1',
      [req.user!.practiceId]
    );

    if (!rows[0] || rows[0].subscription_status !== 'active') {
      res.status(402).json({ error: 'Active subscription required to generate appeals' });
      return;
    }

    next();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
}
