import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db';

const router = Router();

const registerSchema = z.object({
  practiceName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

router.post('/register', async (req, res) => {
  console.log('Register endpoint hit'); // Debug log
  try {
    const { practiceName, name, email, password } = registerSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Check if practice already exists
      let practiceId;
      const { rows: existingPractice } = await client.query(
        'SELECT id FROM practices WHERE email = $1',
        [email]
      );
      
      if (existingPractice.length > 0) {
        practiceId = existingPractice[0].id;
      } else {
        const { rows: [practice] } = await client.query(
          'INSERT INTO practices (name, email, subscription_status) VALUES ($1, $2, $3) RETURNING id',
          [practiceName, email, 'inactive']
        );
        practiceId = practice.id;
      }

      const { rows: [user] } = await client.query(
        `INSERT INTO users (practice_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'admin') 
         ON CONFLICT (practice_id, email) DO UPDATE SET name = $4, password_hash = $3
         RETURNING id, email, name, role`,
        [practiceId, email, passwordHash, name]
      );

      await client.query('COMMIT');

      const { rows: [practice] } = await client.query(
        'SELECT id, name, subscription_status FROM practices WHERE id = $1',
        [practiceId]
      );

      const token = jwt.sign(
        { 
          userId: user.id, 
          practiceId: practice.id, 
          role: user.role, 
          practiceName: practice.name 
        },
        process.env.JWT_SECRET!,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        practice: { id: practice.id, name: practice.name, subscriptionStatus: practice.subscription_status },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Registration error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  console.log('Login endpoint hit');
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { rows: [user] } = await db.query(
      `SELECT u.*, p.name as practice_name, p.subscription_status 
       FROM users u 
       JOIN practices p ON u.practice_id = p.id 
       WHERE u.email = $1`,
      [email]
    );

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = jwt.sign(
      { 
        userId: user.id, 
        practiceId: user.practice_id, 
        role: user.role, 
        practiceName: user.practice_name 
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      practice: {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

    const { rows: [user] } = await db.query(
      `SELECT u.id, u.email, u.name, u.role, 
              p.id as practice_id, p.name as practice_name, p.subscription_status 
       FROM users u 
       JOIN practices p ON u.practice_id = p.id 
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      practice: {
        id: user.practice_id,
        name: user.practice_name,
        subscriptionStatus: user.subscription_status,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
