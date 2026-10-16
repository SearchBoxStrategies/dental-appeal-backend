import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db';

export interface AuthUser {
  userId: number;
  email: string;
  name?: string;
  isAdmin: boolean;
  practiceId?: number;
  role?: string;
  // Within a practice: 'owner' manages team and billing; 'staff' everyone else.
  practiceRole?: string | null;
  // Only dentists can approve clinical notes.
  isDentist?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    // Removed or deactivated team members lose access immediately, not when their token expires.
    const { rows: [user] } = await db.query(
      `SELECT id, email, name, is_admin, practice_id, role, practice_role, is_dentist
       FROM users WHERE id = $1 AND deleted_at IS NULL AND is_active IS NOT FALSE`,
      [decoded.userId]
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = {
      userId: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.is_admin === true,
      practiceId: user.practice_id,
      role: user.role || (user.is_admin ? 'admin' : 'clinic'),
      practiceRole: user.practice_role,
      isDentist: user.is_dentist === true,
    };

    next();
  } catch (error) {
    console.error('❌ Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Team management and billing: practice owners only. Runs after authenticate.
export const requireOwner = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.practiceRole !== 'owner') {
    return res.status(403).json({ error: 'Only the practice owner can do this.' });
  }
  next();
};

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('❌ Admin auth error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
