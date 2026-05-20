import { Router } from 'express';
import { db } from '../db';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';

const router = Router();

// Get all email templates
router.get('/admin/email-templates', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, subject, body, variables, description, is_active, updated_at
       FROM email_templates
       ORDER BY name`
    );
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch email templates:', error);
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

// Get single template by ID
router.get('/admin/email-templates/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, subject, body, variables, description, is_active, updated_at
       FROM email_templates
       WHERE id = $1`,
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Failed to fetch template:', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// Update email template
router.put('/admin/email-templates/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, body, is_active } = req.body;
    
    const { rows } = await db.query(
      `UPDATE email_templates
       SET subject = $1, body = $2, is_active = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, subject, body, variables, description, is_active, updated_at`,
      [subject, body, is_active, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Failed to update template:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// Send test email
router.post('/admin/email-templates/:id/test', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { test_email } = req.body;
    
    if (!test_email) {
      return res.status(400).json({ error: 'Test email address required' });
    }
    
    // Get template
    const { rows: [template] } = await db.query(
      `SELECT subject, body FROM email_templates WHERE id = $1`,
      [id]
    );
    
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Replace test variables
    const testData = {
      practice_name: 'Test Practice',
      name: 'Test User',
      verification_url: 'https://app.dentalappeal.claims/verify/test',
      reset_url: 'https://app.dentalappeal.claims/reset/test',
      patient_name: 'John Doe',
      old_status: 'Draft',
      new_status: 'Appeal Sent',
      appeal_url: 'https://app.dentalappeal.claims/claims/1',
      amount: '199.00',
      date: new Date().toLocaleDateString(),
      billing_url: 'https://app.dentalappeal.claims/billing',
      new_claims: '5',
      new_appeals: '3',
      won_appeals: '2',
      pending_appeals: '4',
      success_rate: '66',
      analytics_url: 'https://app.dentalappeal.claims/analytics'
    };
    
    let testSubject = template.subject;
    let testBody = template.body;
    
    for (const [key, value] of Object.entries(testData)) {
      const regex = new RegExp(`{{${key}}}`, 'g');
      testSubject = testSubject.replace(regex, value);
      testBody = testBody.replace(regex, value);
    }
    
    // Import email service dynamically to avoid circular deps
    const { sendEmail } = await import('../services/email');
    
    await sendEmail({
      to: test_email,
      subject: `[TEST] ${testSubject}`,
      html: testBody,
      text: testBody.replace(/<[^>]*>/g, '')
    });
    
    res.json({ message: `Test email sent to ${test_email}` });
  } catch (error) {
    console.error('Failed to send test email:', error);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

export default router;
