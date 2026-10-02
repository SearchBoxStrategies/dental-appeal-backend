import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: '/home/u884476253/.env_dentalappeal' });
// Local development: fall back to ./.env (never overrides values already loaded above)
dotenv.config();

import express from 'express';
import cors from 'cors';
import adminRouter from './routes/admin';
import authRouter from './routes/auth.js';
import claimsRouter from './routes/claims';
import appealsRouter from './routes/appeals';
import billingRouter from './routes/billing';
import webhookRouter from './routes/webhook';
import cdtCodesRouter from './routes/cdtCodes';
import documentRouter from './routes/documents';
import userRouter from './routes/user';
import analyticsRouter from './routes/analytics';
import bulkUploadRouter from './routes/bulkUpload';
import practiceRouter from './routes/practice';
import insuranceRouter from './routes/insurance';
import affiliateRouter from './routes/affiliate';
import adminEmailTemplatesRouter from './routes/adminEmailTemplates';
import calculatorRouter from './routes/calculator';

const app = express();
console.log('✅ Backend starting up...');
const PORT = process.env.PORT ?? 3001;

// Explicit CORS configuration for browser compatibility
app.use(cors({ 
  origin: ['https://app.dentalappeal.claims', 'http://localhost:5173', 'https://api.dentalappeal.claims'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Stripe webhook requires raw body — must be registered before express.json()
app.use('/api/webhook', webhookRouter);

app.use(express.json());

// Register all API routes
app.use('/api/auth', authRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/appeals', appealsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/cdt-codes', cdtCodesRouter);
app.use('/api/documents', documentRouter);
app.use('/api/user', userRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/bulk', bulkUploadRouter);
app.use('/api/practice', practiceRouter);
app.use('/api/insurance', insuranceRouter);
app.use('/api/affiliate', affiliateRouter);
app.use('/api', adminEmailTemplatesRouter);
app.use('/api', calculatorRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});
