import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRouter from './routes/auth';
import claimsRouter from './routes/claims';
import appealsRouter from './routes/appeals';
import billingRouter from './routes/billing';
import webhookRouter from './routes/webhook';
import cdtCodesRouter from './routes/cdtCodes';

const app = express();
console.log('✅ Backend starting up...');
const PORT = process.env.PORT ?? 3001;

app.use(cors({ origin: true, credentials: true }));

// Stripe webhook requires raw body — must be registered before express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/appeals', appealsRouter);
app.use('/api/billing', billingRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/cdt-codes', cdtCodesRouter);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
