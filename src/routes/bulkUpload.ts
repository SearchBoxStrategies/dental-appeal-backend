import { Router } from 'express';
import multer from 'multer';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const parseDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
  return new Date().toISOString().split('T')[0];
};

router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  const file = req.file;
  const practiceId = req.user!.practiceId;
  const userId = req.user!.userId;
  
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  
  const results: any[] = [];
  let successful = 0;
  let failed = 0;
  
  const stream = Readable.from(file.buffer.toString());
  
  stream
    .pipe(csv())
    .on('data', (row) => {
      results.push(row);
    })
    .on('end', async () => {
      for (const row of results) {
        try {
          await db.query(
            `INSERT INTO claims (
              practice_id, created_by, patient_name, patient_dob, insurance_company,
              policy_number, claim_number, procedure_codes, denial_reason, service_date,
              amount_claimed, amount_denied, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')`,
            [
              practiceId, userId,
              row.patient_name,
              parseDate(row.patient_dob),
              row.insurance_company,
              row.policy_number,
              row.claim_number,
              (row.procedure_codes || '').split(','),
              row.denial_reason,
              parseDate(row.service_date),
              parseFloat(row.amount_claimed) || 0,
              parseFloat(row.amount_denied) || 0
            ]
          );
          successful++;
        } catch (err) {
          failed++;
          console.error('Bulk insert error:', err);
        }
      }
      res.json({ successful, failed, total: results.length });
    });
});

export default router;
