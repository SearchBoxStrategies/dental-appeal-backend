import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { validateClaim, getValidationSummary } from '../services/validation';
import { requireActiveSubscription } from '../middleware/subscription';
import { aiLimiter } from '../middleware/rateLimit';
import { extractClaimFromDocument, draftDentistNote, ClaudeError } from '../services/claude';
import { buildChecklist } from '../services/checklist';
import multer from 'multer';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, 'Use YYYY-MM-DD');

// Denial notices: one photo or PDF, read in memory and never stored by this endpoint.
const eobUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('Upload a PDF, JPG or PNG of the denial notice.'));
  },
}).single('file');

// Read a denial notice (EOB) and return the claim fields for the form to prefill.
router.post('/extract', authenticate, requireActiveSubscription, aiLimiter, (req, res) => {
  eobUpload(req, res, async (uploadError: unknown) => {
    if (uploadError) {
      const tooBig = (uploadError as any)?.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig ? 'File is too large (10 MB max).' : (uploadError as Error).message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const extracted = await extractClaimFromDocument(req.file);
      if (!extracted.isDenialNotice) {
        return res.status(422).json({ error: 'This does not look like a dental insurance denial or EOB.' });
      }

      // Drop dates the form can't use, and match the insurer to the list the form offers.
      const uncertain = new Set(extracted.uncertainFields);
      for (const field of ['patientDob', 'serviceDate', 'denialDate'] as const) {
        const value = extracted[field];
        if (value && !ISO_DATE.test(value)) {
          extracted[field] = null;
          uncertain.add(field);
        }
      }
      let insuranceCompanyId: number | null = null;
      if (extracted.insuranceCompany) {
        const { rows: [match] } = await db.query(
          `SELECT id, name FROM insurance_companies
           WHERE is_active IS NOT FALSE
             AND (LOWER($1::text) LIKE '%' || LOWER(name) || '%' OR LOWER(name) LIKE '%' || LOWER($1::text) || '%')
           ORDER BY LENGTH(name) DESC LIMIT 1`,
          [extracted.insuranceCompany]
        );
        if (match) {
          insuranceCompanyId = match.id;
          extracted.insuranceCompany = match.name;
        }
      }

      res.json({
        ...extracted,
        procedureCodes: extracted.procedureCodes.map((code) => code.trim().toUpperCase()),
        insuranceCompanyId,
        uncertainFields: [...uncertain],
      });
    } catch (error) {
      if (error instanceof ClaudeError) return res.status(422).json({ error: error.message });
      console.error('EOB extraction error:', error);
      res.status(502).json({ error: 'Could not read the document right now. Please try again or enter the claim by hand.' });
    }
  });
});

// Claims that need action: appeal deadlines within 14 days, and appeals sent 30+ days ago
// with no answer yet.
router.get('/attention', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, patient_name, insurance_company, amount_denied, status,
              to_char(appeal_deadline, 'YYYY-MM-DD') AS appeal_deadline,
              (appeal_deadline - CURRENT_DATE)::int AS days_left,
              appealed_at,
              (CURRENT_DATE - appealed_at::date)::int AS days_since_appeal,
              CASE WHEN status IN ('appealed', 'under_review') THEN 'follow_up' ELSE 'deadline' END AS kind
       FROM claims
       WHERE practice_id = $1 AND deleted_at IS NULL
         AND (
           (status IN ('pending', 'draft') AND appeal_deadline IS NOT NULL
             AND appeal_deadline <= CURRENT_DATE + 14)
           OR (status IN ('appealed', 'under_review') AND appealed_at IS NOT NULL
             AND appealed_at <= NOW() - INTERVAL '30 days')
         )
       ORDER BY kind, appeal_deadline NULLS LAST, appealed_at`,
      [req.user!.practiceId]
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
      'SELECT id, status, model_used, created_at, edited_at, letter_content FROM appeals WHERE claim_id = $1 ORDER BY created_at DESC',
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
    const resolves = RESOLVED_STATUSES.includes(status);
    const sent = status === 'appealed' || status === 'under_review';
    const notSent = status === 'pending' || status === 'draft';

    // Each parameter is used once with an explicit type: Postgres rejects a parameter that it
    // infers as both text and varchar.
    const { rows: [claim] } = await db.query(
      `UPDATE claims
       SET status = $1,
           amount_recovered = CASE
             WHEN NOT $4::boolean THEN NULL
             WHEN $5::numeric IS NOT NULL THEN $5::numeric
             ELSE amount_recovered
           END,
           resolved_at = CASE
             WHEN $6::boolean THEN COALESCE(resolved_at, NOW())
             ELSE NULL
           END,
           -- Start the 30-day follow-up clock when the appeal goes out.
           appealed_at = CASE
             WHEN $7::boolean THEN COALESCE(appealed_at, NOW())
             WHEN $8::boolean THEN NULL
             ELSE appealed_at
           END,
           follow_up_reminder_sent_at = CASE
             WHEN $7::boolean AND appealed_at IS NULL THEN NULL
             ELSE follow_up_reminder_sent_at
           END,
           updated_at = NOW()
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [status, claimId, practiceId, recovers, amountRecovered ?? null, resolves, sent, notSent]
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
  denialDate: isoDate.nullable().optional(),
});

router.post('/', authenticate, async (req, res) => {
  try {
    const data = claimSchema.parse(req.body);

    const { rows: [claim] } = await db.query(
      `INSERT INTO claims (
         practice_id, created_by, patient_name, patient_dob, insurance_company,
         insurance_company_id, policy_number, claim_number, procedure_codes, 
         denial_reason, service_date, amount_claimed, amount_denied,
         denial_date, appeal_deadline
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date,
         -- Deadline: the insurer's appeal window counted from the denial date (or today).
         COALESCE($14::date, CURRENT_DATE)
           + COALESCE((SELECT appeal_window_days FROM insurance_companies WHERE id = $6), 180)
       )
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
        data.denialDate ?? null,
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

// Load a claim of the caller's practice, or send 404.
async function loadClaim(req: Request, res: Response) {
  const { rows: [claim] } = await db.query(
    'SELECT * FROM claims WHERE id = $1 AND practice_id = $2',
    [req.params.id, req.user!.practiceId]
  );
  if (!claim) res.status(404).json({ error: 'Claim not found' });
  return claim;
}

const workflowView = (claim: any) => ({
  checklist: buildChecklist(claim.procedure_codes, claim.denial_reason),
  checklistState: claim.checklist_state || {},
  dentistNote: claim.dentist_note,
  dentistNoteApprovedAt: claim.dentist_note_approved_at,
  dentistNoteApprovedBy: claim.dentist_note_approved_by,
});

// Attachment checklist and dentist note for a claim.
router.get('/:id/workflow', authenticate, async (req, res) => {
  try {
    const claim = await loadClaim(req, res);
    if (!claim) return;
    res.json(workflowView(claim));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const checklistStateSchema = z.object({
  state: z.record(z.string().max(64), z.boolean()).refine((v) => Object.keys(v).length <= 100),
});

router.put('/:id/checklist', authenticate, async (req, res) => {
  try {
    const parsed = checklistStateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid checklist' });
    const { rows: [claim] } = await db.query(
      `UPDATE claims SET checklist_state = $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND practice_id = $3 RETURNING *`,
      [JSON.stringify(parsed.data.state), req.params.id, req.user!.practiceId]
    );
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    res.json(workflowView(claim));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AI drafts the clinical note; the dentist edits and approves it below.
router.post('/:id/dentist-note/draft', authenticate, requireActiveSubscription, aiLimiter, async (req, res) => {
  try {
    const claim = await loadClaim(req, res);
    if (!claim) return;
    const { note } = await draftDentistNote({
      procedureCodes: claim.procedure_codes,
      denialReason: claim.denial_reason,
      serviceDate: claim.service_date,
      insuranceCompany: claim.insurance_company,
      checklist: buildChecklist(claim.procedure_codes, claim.denial_reason).map((item) => item.label),
    });
    const { rows: [updated] } = await db.query(
      `UPDATE claims SET dentist_note = $1, dentist_note_approved_at = NULL,
              dentist_note_approved_by = NULL, updated_at = NOW()
       WHERE id = $2 AND practice_id = $3 RETURNING *`,
      [note, claim.id, req.user!.practiceId]
    );
    res.json(workflowView(updated));
  } catch (error) {
    if (error instanceof ClaudeError) return res.status(422).json({ error: error.message });
    console.error('Dentist note draft error:', error);
    res.status(502).json({ error: 'Could not draft the note right now. Please try again.' });
  }
});

const dentistNoteSchema = z.object({
  note: z.string().trim().min(1).max(10000),
  // Approving requires the dentist's name, which is recorded as the sign-off.
  approve: z.boolean().optional(),
  approverName: z.string().trim().min(2).max(255).optional(),
});

router.put('/:id/dentist-note', authenticate, async (req, res) => {
  try {
    const parsed = dentistNoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Note text is required' });
    const { note, approve, approverName } = parsed.data;
    if (approve && !approverName) {
      return res.status(400).json({ error: "Enter the dentist's name to approve the note" });
    }
    if (approve && /\[[^\]]+\]/.test(note)) {
      return res.status(400).json({ error: 'Fill in or remove every [bracketed] placeholder before approving' });
    }
    // Any edit clears an earlier approval; approving stamps who and when.
    const { rows: [claim] } = await db.query(
      `UPDATE claims
       SET dentist_note = $1,
           dentist_note_approved_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
           dentist_note_approved_by = CASE WHEN $2::boolean THEN $3::varchar ELSE NULL END,
           updated_at = NOW()
       WHERE id = $4 AND practice_id = $5 RETURNING *`,
      [note, !!approve, approverName ?? null, req.params.id, req.user!.practiceId]
    );
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    res.json(workflowView(claim));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const deadlineSchema = z.object({
  denialDate: isoDate.nullable().optional(),
  appealDeadline: isoDate.nullable().optional(),
});

// Set the denial date (deadline recalculated from the insurer's window) or the deadline itself.
router.patch('/:id/deadline', authenticate, async (req, res) => {
  try {
    const parsed = deadlineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
    const { denialDate, appealDeadline } = parsed.data;
    const { rows: [claim] } = await db.query(
      `UPDATE claims c
       SET denial_date = CASE WHEN $1::boolean THEN $2::date ELSE c.denial_date END,
           appeal_deadline = CASE
             WHEN $3::date IS NOT NULL THEN $3::date
             WHEN $1::boolean THEN COALESCE($2::date, c.created_at::date)
               + COALESCE((SELECT appeal_window_days FROM insurance_companies WHERE id = c.insurance_company_id), 180)
             ELSE c.appeal_deadline
           END,
           deadline_reminder_sent_at = NULL,
           updated_at = NOW()
       WHERE c.id = $4 AND c.practice_id = $5 RETURNING *`,
      [denialDate !== undefined, denialDate ?? null, appealDeadline ?? null, req.params.id, req.user!.practiceId]
    );
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    res.json(claim);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
