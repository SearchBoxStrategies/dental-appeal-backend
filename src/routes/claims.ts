import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { validateClaim, getValidationSummary } from '../services/validation';

const router = Router();

router.get('/stats', authenticate, async (req, res) => {
  try {
    const { rows: [stats] } = await db.query(
      `SELECT
         COUNT(DISTINCT c.id)::int AS total_claims,
         COUNT(DISTINCT a.id)::int AS total_appeals,
         COUNT(DISTINCT CASE WHEN a.created_at >= date_trunc('month', NOW()) THEN a.id END)::int AS appeals_this_month
       FROM claims c
       LEFT JOIN appeals a ON a.claim_id = c.id
       WHERE c.practice_id = $1`,
      [req.user!.practiceId]
    );
    res.json({
      totalClaims: stats.total_claims,
      totalAppeals: stats.total_appeals,
      appealsThisMonth: stats.appeals_this_month,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 0, 0), 500);
    const { rows } = await db.query(
      `SELECT c.*, u.name AS created_by_name
       FROM claims c
       JOIN users u ON c.created_by = u.id
       WHERE c.practice_id = $1
       ORDER BY c.created_at DESC
       ${limit ? 'LIMIT $2' : ''}`,
      limit ? [req.user!.practiceId, limit] : [req.user!.practiceId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [claim] } = await db.query(
      'SELECT * FROM claims WHERE id = $1 AND practice_id = $2',
      [req.params.id, req.user!.practiceId]
    );

    if (!claim) {
      res.status(404).json({ error: 'Claim not found' });
      return;
    }

    const { rows: appeals } = await db.query(
      'SELECT id, status, model_used, created_at FROM appeals WHERE claim_id = $1 ORDER BY created_at DESC',
      [claim.id]
    );

    res.json({ ...claim, appeals });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const CLAIM_STATUSES = ['pending', 'draft', 'appealed', 'under_review', 'won', 'lost', 'paid'] as const;
const RESOLVED_STATUSES = ['won', 'lost', 'paid'];

const statusSchema = z.object({
  status: z.enum(CLAIM_STATUSES),
  // What the insurer paid after the appeal; only meaningful for won/paid.
  amountRecovered: z.number().nonnegative().max(1_000_000).nullable().optional(),
});

// Update claim status endpoint
router.patch('/:id/status', authenticate, async (req, res) => {
  try {
    const claimId = req.params.id;
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid status or recovered amount' });
    }
    const { status, amountRecovered } = parsed.data;
    const practiceId = req.user!.practiceId;
    const recovers = status === 'won' || status === 'paid';

    const { rows: [claim] } = await db.query(
      `UPDATE claims
       SET status = $1,
           amount_recovered = CASE
             WHEN NOT $4 THEN NULL
             WHEN $5::numeric IS NOT NULL THEN $5::numeric
             ELSE amount_recovered
           END,
           resolved_at = CASE
             WHEN $1 = ANY($6::text[]) THEN COALESCE(resolved_at, NOW())
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [status, claimId, practiceId, recovers, amountRecovered ?? null, RESOLVED_STATUSES]
    );
    
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    
    res.json(claim);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Validate claim before generating appeal
router.post('/:id/validate', authenticate, async (req, res) => {
  try {
    const claimId = parseInt(req.params.id);
    
    // Verify claim belongs to user
    const { rows: [claim] } = await db.query(
      'SELECT * FROM claims WHERE id = $1 AND practice_id = $2',
      [claimId, req.user!.practiceId]
    );
    
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    
    const validation = await validateClaim(claim, claimId);
    const summary = await getValidationSummary(claimId);
    
    res.json({ validation, summary });
  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({ error: 'Failed to validate claim' });
  }
});

const claimSchema = z.object({
  patientName: z.string().min(1),
  patientDob: z.string(),
  insuranceCompany: z.string().min(1),
  insuranceCompanyId: z.number().optional(),
  policyNumber: z.string().nullable().optional(),  // ← Allow null
  claimNumber: z.string().nullable().optional(),   // ← Allow null
  procedureCodes: z.array(z.string()).min(1),
  denialReason: z.string().min(1),
  serviceDate: z.string(),
  amountClaimed: z.number().nullable().optional(),
  amountDenied: z.number().nullable().optional(),
});

router.post('/', authenticate, async (req, res) => {
  try {
    const data = claimSchema.parse(req.body);

    const { rows: [claim] } = await db.query(
      `INSERT INTO claims (
         practice_id, created_by, patient_name, patient_dob, insurance_company,
         insurance_company_id, policy_number, claim_number, procedure_codes, 
         denial_reason, service_date, amount_claimed, amount_denied
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        req.user!.practiceId,
        req.user!.userId,
        data.patientName,
        data.patientDob,
        data.insuranceCompany,
        data.insuranceCompanyId ?? null,
        data.policyNumber ?? null,
        data.claimNumber ?? null,
        data.procedureCodes,
        data.denialReason,
        data.serviceDate,
        data.amountClaimed ?? null,
        data.amountDenied ?? null,
      ]
    );

    res.status(201).json(claim);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
