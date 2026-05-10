import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { requireActiveSubscription } from '../middleware/subscription';
import { generateAppealLetter } from '../services/claude';

const router = Router();

router.post('/generate/:claimId', authenticate, async (req, res) => {
  try {
    const { rows: [claim] } = await db.query(
      'SELECT * FROM claims WHERE id = $1 AND practice_id = $2',
      [req.params.claimId, req.user!.practiceId]
    );

    if (!claim) {
      res.status(404).json({ error: 'Claim not found' });
      return;
    }

    const { rows: [practice] } = await db.query(
      'SELECT name FROM practices WHERE id = $1',
      [req.user!.practiceId]
    );

    // Pass ALL claim data to the AI
    const { letter, model, promptUsed } = await generateAppealLetter({
      patientName: claim.patient_name,
      patientDob: claim.patient_dob,
      insuranceCompany: claim.insurance_company,
      policyNumber: claim.policy_number,
      claimNumber: claim.claim_number,
      procedureCodes: claim.procedure_codes,
      denialReason: claim.denial_reason,
      serviceDate: claim.service_date,
      amountClaimed: claim.amount_claimed ? parseFloat(claim.amount_claimed) : null,
      amountDenied: claim.amount_denied ? parseFloat(claim.amount_denied) : null,
      practiceName: practice.name,
    });

    // Save to database
    const { rows: [appeal] } = await db.query(
      `INSERT INTO appeals (claim_id, letter_content, model_used)
       VALUES ($1, $2, $3) RETURNING *`,
      [claim.id, letter, model]
    );

    res.status(201).json(appeal);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate appeal letter' });
  }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [appeal] } = await db.query(
      `SELECT a.*, c.patient_name, c.insurance_company, c.claim_number,
              c.procedure_codes, c.denial_reason, c.service_date
       FROM appeals a
       JOIN claims c ON a.claim_id = c.id
       WHERE a.id = $1 AND a.practice_id = $2`,
      [req.params.id, req.user!.practiceId]
    );

    if (!appeal) {
      res.status(404).json({ error: 'Appeal not found' });
      return;
    }

    res.json(appeal);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
