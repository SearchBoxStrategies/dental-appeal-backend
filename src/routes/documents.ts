import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

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
    const claimId = parseInt(req.params.claimId);
    const userId = req.user!.userId;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // For now, store base64 in database (for MVP)
    // For production, use cloud storage like AWS S3 or Supabase Storage
    const base64Data = file.buffer.toString('base64');
    const fileUrl = `data:${file.mimetype};base64,${base64Data}`;
    
    const { rows: [document] } = await db.query(
      `INSERT INTO claim_documents (claim_id, user_id, file_name, file_url, file_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [claimId, userId, file.originalname, fileUrl, file.mimetype, file.size]
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
    const claimId = parseInt(req.params.claimId);
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

// Delete a document
router.delete('/documents/:id', authenticate, async (req, res) => {
  try {
    const documentId = parseInt(req.params.id);
    await db.query('DELETE FROM claim_documents WHERE id = $1', [documentId]);
    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

export default router;
