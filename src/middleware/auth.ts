import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db';

export interface AuthUser {
  userId: number;
  email: string;
  isAdmin: boolean;
  practiceId?: number;
  role?: string;
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

    const { rows: [user] } = await db.query(
      `SELECT id, email, is_admin, practice_id, role FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = {
      userId: user.id,
      email: user.email,
      isAdmin: user.is_admin === true,
      practiceId: user.practice_id,
      role: user.role || (user.is_admin ? 'admin' : 'clinic')
    };

    next();
  } catch (error) {
    console.error('❌ Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
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
