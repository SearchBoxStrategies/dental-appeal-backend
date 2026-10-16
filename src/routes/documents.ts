import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { saveFile, readFile, deleteFile } from '../services/fileStorage';

const router = Router();

// Returns true if the claim exists and belongs to the caller's practice.
async function claimBelongsToPractice(claimId: string, practiceId: number): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM claims WHERE id = $1 AND practice_id = $2',
    [claimId, practiceId]
  );
  return rows.length > 0;
}

// Configure multer for file upload (memory storage - you can also use disk storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF are allowed.'));
    }
  }
});

// Upload document to a claim
router.post('/claims/:claimId/documents', authenticate, upload.single('file'), async (req, res) => {
  try {
    const claimId = req.params.claimId;
    const userId = req.user!.userId;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!(await claimBelongsToPractice(claimId, req.user!.practiceId))) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    // Saved as an encrypted file outside the database. If the disk is unavailable, fall back to
    // the database so the upload still succeeds (and log it, so it gets fixed).
    let storageKey: string | null = null;
    let fileUrl: string | null = null;
    try {
      storageKey = await saveFile(file.buffer);
    } catch (storageError) {
      console.error('File storage unavailable, keeping this document in the database:', storageError);
      fileUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    }

    const { rows: [document] } = await db.query(
      `INSERT INTO claim_documents (claim_id, user_id, file_name, file_url, storage_key, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, claim_id, file_name, file_type, file_size, uploaded_at`,
      [claimId, userId, file.originalname, fileUrl, storageKey, file.mimetype, file.size]
    );

    res.status(201).json(document);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// Get all documents for a claim
router.get('/claims/:claimId/documents', authenticate, async (req, res) => {
  try {
    const claimId = req.params.claimId;
    if (!(await claimBelongsToPractice(claimId, req.user!.practiceId))) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    const { rows } = await db.query(
      'SELECT id, file_name, file_type, file_size, uploaded_at FROM claim_documents WHERE claim_id = $1 ORDER BY uploaded_at DESC',
      [claimId]
    );
    res.json(rows);
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// View or download a document (only for the claim's practice).
router.get('/:id/file', authenticate, async (req, res) => {
  try {
    const { rows: [doc] } = await db.query(
      `SELECT d.file_name, d.file_type, d.storage_key, d.file_url
       FROM claim_documents d JOIN claims c ON c.id = d.claim_id
       WHERE d.id = $1 AND c.practice_id = $2`,
      [req.params.id, req.user!.practiceId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    let data: Buffer;
    if (doc.storage_key) {
      data = await readFile(doc.storage_key);
    } else if (typeof doc.file_url === 'string' && doc.file_url.startsWith('data:')) {
      data = Buffer.from(doc.file_url.slice(doc.file_url.indexOf(',') + 1), 'base64');
    } else {
      return res.status(404).json({ error: 'Document file is missing' });
    }

    const safeName = String(doc.file_name || 'document').replace(/[^\w.\- ]+/g, '_');
    res.setHeader('Content-Type', doc.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  } catch (error) {
    console.error('Read document error:', error);
    res.status(500).json({ error: 'Could not open the document' });
  }
});

// Delete a document (client calls DELETE /api/documents/:id)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [deleted] } = await db.query(
      `DELETE FROM claim_documents d
       USING claims c
       WHERE d.id = $1 AND d.claim_id = c.id AND c.practice_id = $2
       RETURNING d.storage_key`,
      [req.params.id, req.user!.practiceId]
    );
    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }
    if (deleted.storage_key) {
      await deleteFile(deleted.storage_key).catch((err) => console.error('Could not remove stored file:', err));
    }
    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

export default router;
