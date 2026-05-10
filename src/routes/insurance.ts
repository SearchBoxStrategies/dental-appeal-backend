import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

// Get all insurance companies (for dropdown)
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, code, appeals_address, timely_filing_days FROM insurance_companies WHERE is_active = TRUE ORDER BY name'
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch insurance companies' });
  }
});

// Get insurance company by ID (for appeal letter)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [company] } = await db.query(
      'SELECT * FROM insurance_companies WHERE id = $1',
      [req.params.id]
    );
    
    if (!company) {
      return res.status(404).json({ error: 'Insurance company not found' });
    }
    
    res.json(company);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch insurance company' });
  }
});

// Admin: Create new insurance company
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, code, address_line1, address_line2, city, state, zip, 
            phone, fax, email, website, claims_address, appeals_address, 
            appeals_department, timely_filing_days } = req.body;
    
    const { rows: [company] } = await db.query(
      `INSERT INTO insurance_companies 
       (name, code, address_line1, address_line2, city, state, zip, 
        phone, fax, email, website, claims_address, appeals_address, 
        appeals_department, timely_filing_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [name, code, address_line1, address_line2, city, state, zip, 
       phone, fax, email, website, claims_address, appeals_address, 
       appeals_department, timely_filing_days]
    );
    
    res.status(201).json(company);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create insurance company' });
  }
});

// Admin: Update insurance company
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const companyId = req.params.id;
    const { name, code, address_line1, address_line2, city, state, zip, 
            phone, fax, email, website, claims_address, appeals_address, 
            appeals_department, timely_filing_days, is_active } = req.body;
    
    const { rows: [company] } = await db.query(
      `UPDATE insurance_companies 
       SET name = COALESCE($1, name),
           code = COALESCE($2, code),
           address_line1 = COALESCE($3, address_line1),
           address_line2 = COALESCE($4, address_line2),
           city = COALESCE($5, city),
           state = COALESCE($6, state),
           zip = COALESCE($7, zip),
           phone = COALESCE($8, phone),
           fax = COALESCE($9, fax),
           email = COALESCE($10, email),
           website = COALESCE($11, website),
           claims_address = COALESCE($12, claims_address),
           appeals_address = COALESCE($13, appeals_address),
           appeals_department = COALESCE($14, appeals_department),
           timely_filing_days = COALESCE($15, timely_filing_days),
           is_active = COALESCE($16, is_active),
           updated_at = NOW()
       WHERE id = $17
       RETURNING *`,
      [name, code, address_line1, address_line2, city, state, zip, 
       phone, fax, email, website, claims_address, appeals_address, 
       appeals_department, timely_filing_days, is_active, companyId]
    );
    
    res.json(company);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update insurance company' });
  }
});

export default router;
