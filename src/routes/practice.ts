import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';

const router = Router();

// Get practice profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    
    const { rows: [practice] } = await db.query(
      `SELECT id, name, address, city, state, zip, phone, fax, website, 
              logo_url, npi_number, tax_id, provider_name, provider_license, profile_completed
       FROM practices WHERE id = $1`,
      [practiceId]
    );
    
    res.json(practice || {});
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch practice profile' });
  }
});

// Update practice profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    const { 
      name, address, city, state, zip, phone, fax, website,
      npi_number, tax_id, provider_name, provider_license
    } = req.body;
    
    await db.query(
      `UPDATE practices 
       SET name = COALESCE($1, name),
           address = COALESCE($2, address),
           city = COALESCE($3, city),
           state = COALESCE($4, state),
           zip = COALESCE($5, zip),
           phone = COALESCE($6, phone),
           fax = COALESCE($7, fax),
           website = COALESCE($8, website),
           npi_number = COALESCE($9, npi_number),
           tax_id = COALESCE($10, tax_id),
           provider_name = COALESCE($11, provider_name),
           provider_license = COALESCE($12, provider_license),
           profile_completed = TRUE
       WHERE id = $13`,
      [name, address, city, state, zip, phone, fax, website, 
       npi_number, tax_id, provider_name, provider_license, practiceId]
    );
    
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update practice profile' });
  }
});

export default router;
