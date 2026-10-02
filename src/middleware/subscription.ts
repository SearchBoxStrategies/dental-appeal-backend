import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

// New practices are created with status 'trial'; this is how long that lasts.
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS ?? '14', 10);

export async function requireActiveSubscription(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { rows } = await db.query(
      `SELECT subscription_status,
              created_at > NOW() - make_interval(days => $2) AS in_trial_window
       FROM practices WHERE id = $1`,
      [req.user!.practiceId, TRIAL_DAYS]
    );

    const practice = rows[0];
    const status = practice?.subscription_status;
    const allowed =
      status === 'active' ||
      status === 'trialing' ||
      (status === 'trial' && practice.in_trial_window);

    if (!allowed) {
      res.status(402).json({
        error: status === 'trial'
          ? 'Your free trial has ended. Subscribe on the Billing page to keep generating appeals.'
          : 'An active subscription is required to generate appeals. Visit the Billing page to subscribe.',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
