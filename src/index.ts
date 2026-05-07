import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import adminRouter from './routes/admin';
import authRouter from './routes/auth';
import claimsRouter from './routes/claims';
import appealsRouter from './routes/appeals';
import billingRouter from './routes/billing';
import webhookRouter from './routes/webhook';
import cdtCodesRouter from './routes/cdtCodes';
import documentRouter from './routes/documents';
import userRouter from './routes/user';
import analyticsRouter from './routes/analytics';

const app = express();
console.log('✅ Backend starting up...');
const PORT = process.env.PORT ?? 3001;

app.use(cors({ origin: true, credentials: true }));

// Stripe webhook requires raw body — must be registered before express.json()
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());

// Register all API routes
app.use('/api/auth', authRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/appeals', appealsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/cdt-codes', cdtCodesRouter);
app.use('/api/documents', documentRouter);
app.use('/api/user', userRouter);
app.use('/api/admin', adminRouter);  // Admin routes - moved up for proper registration

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Debug: List all registered routes
console.log('\n📋 Registered Routes:');

// Log direct routes
app._router.stack.forEach((r: any) => {
  if (r.route && r.route.path) {
    console.log(`  ✅ ${Object.keys(r.route.methods).join(', ').toUpperCase()} /api${r.route.path}`);
  }
});

// Log all router routes for debugging
const routers = [
  { path: '/api/auth', router: authRouter, name: 'Auth' },
  { path: '/api/claims', router: claimsRouter, name: 'Claims' },
  { path: '/api/appeals', router: appealsRouter, name: 'Appeals' },
  { path: '/api/billing', router: billingRouter, name: 'Billing' },
  { path: '/api/cdt-codes', router: cdtCodesRouter, name: 'CDTCodes' },
  { path: '/api/admin', router: adminRouter, name: 'Admin' }  // Added admin router to debug list
];

routers.forEach(({ path, router, name }) => {
  if (router && router.stack) {
    router.stack.forEach((layer: any) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(', ').toUpperCase();
        const fullPath = `${path}${layer.route.path}`;
        console.log(`  🔵 ${methods} ${fullPath} [${name}]`);
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});
