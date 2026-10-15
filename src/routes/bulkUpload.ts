import { Router } from 'express';
import multer from 'multer';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { normalizeCode, isValidCodeFormat } from '../utils/procedureCodes';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MAX_ROWS = 10_000;
const MAX_REPORTED_ERRORS = 100;

// Only unambiguous dates: YYYY-MM-DD. 03/04/2024 means different days in the US and Canada.
const isoDate = (value: string | undefined): string | null => {
  const v = (value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
};

// Empty is allowed; anything else must be a plain number (a $ sign and commas are tolerated).
const amount = (value: string | undefined): number | null | 'invalid' => {
  const v = (value || '').trim().replace(/[$,\s]/g, '');
  if (!v) return null;
  return /^\d+(\.\d{1,2})?$/.test(v) ? parseFloat(v) : 'invalid';
};

const parseCsv = (buffer: Buffer) =>
  new Promise<Record<string, string>[]>((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    Readable.from(buffer.toString('utf8').replace(/^﻿/, ''))
      .pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() }))
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });

router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  const file = req.file;
  const practiceId = req.user!.practiceId;
  const userId = req.user!.userId;

  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!/\.csv$/i.test(file.originalname)) {
    return res.status(400).json({ error: 'Upload a .csv file (in Excel: File > Save As > CSV).' });
  }

  let rows: Record<string, string>[];
  try {
    rows = await parseCsv(file.buffer);
  } catch {
    return res.status(400).json({ error: 'Could not read the CSV file.' });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'The file has no claim rows.' });
  if (rows.length > MAX_ROWS) return res.status(400).json({ error: `Up to ${MAX_ROWS.toLocaleString()} claims per file.` });

  const required = ['patient_name', 'patient_dob', 'insurance_company', 'procedure_codes', 'denial_reason', 'service_date'];
  const missingColumns = required.filter((col) => !(col in rows[0]));
  if (missingColumns.length) {
    return res.status(400).json({ error: `Missing column(s): ${missingColumns.join(', ')}. Download the template for the expected format.` });
  }

  type Insurer = { id: number; name: string; appeal_window_days: number | null };
  const { rows: insurerRows } = await db.query('SELECT id, name, appeal_window_days FROM insurance_companies');
  const insurerByName = new Map<string, Insurer>();
  for (const i of insurerRows as Insurer[]) insurerByName.set(String(i.name).toLowerCase(), i);

  let successful = 0;
  const errors: { row: number; message: string }[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2; // the header is row 1 in the spreadsheet
    const problems: string[] = [];

    const patientName = (row.patient_name || '').trim();
    const insurance = (row.insurance_company || '').trim();
    const denialReason = (row.denial_reason || '').trim();
    const dob = isoDate(row.patient_dob);
    const serviceDate = isoDate(row.service_date);
    const denialDate = row.denial_date?.trim() ? isoDate(row.denial_date) : null;
    const codes = [...new Set((row.procedure_codes || '').split(/[\s,;]+/).filter(Boolean).map(normalizeCode))];
    const badCodes = codes.filter((c) => !isValidCodeFormat(c));
    const claimed = amount(row.amount_claimed);
    const denied = amount(row.amount_denied);

    if (!patientName) problems.push('patient_name is empty');
    if (!dob) problems.push('patient_dob must be YYYY-MM-DD');
    if (!insurance) problems.push('insurance_company is empty');
    if (!codes.length) problems.push('procedure_codes is empty');
    if (badCodes.length) problems.push(`procedure code(s) ${badCodes.join(', ')} not valid (use D2740 or 27211 style)`);
    if (!denialReason) problems.push('denial_reason is empty');
    if (!serviceDate) problems.push('service_date must be YYYY-MM-DD');
    if (row.denial_date?.trim() && !denialDate) problems.push('denial_date must be YYYY-MM-DD');
    if (claimed === 'invalid') problems.push('amount_claimed is not a number');
    if (denied === 'invalid') problems.push('amount_denied is not a number');

    if (problems.length) {
      if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row: rowNumber, message: problems.join('; ') });
      continue;
    }

    const insurer = insurerByName.get(insurance.toLowerCase());
    try {
      await db.query(
        `INSERT INTO claims (
           practice_id, created_by, patient_name, patient_dob, insurance_company, insurance_company_id,
           policy_number, claim_number, procedure_codes, denial_reason, service_date,
           amount_claimed, amount_denied, status, denial_date, appeal_deadline
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14::date,
           COALESCE($14::date, CURRENT_DATE) + $15::int)`,
        [
          practiceId, userId, patientName, dob, insurer?.name ?? insurance, insurer?.id ?? null,
          row.policy_number?.trim() || null, row.claim_number?.trim() || null, codes, denialReason, serviceDate,
          claimed, denied, denialDate, insurer?.appeal_window_days ?? 180,
        ]
      );
      successful++;
    } catch (err) {
      console.error('Bulk insert error:', err);
      if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row: rowNumber, message: 'Could not be saved' });
    }
  }

  res.json({ successful, failed: rows.length - successful, total: rows.length, errors });
});

export default router;
