import { Router } from 'express';
import { db } from '../db';
import { sendEmail } from '../services/email';

const router = Router();

// Send calculator report via email
router.post('/calculator/send-report', async (req, res) => {
  try {
    const {
      email,
      annualLoss,
      monthlyLoss,
      monthlyClaims,
      denialRate,
      avgClaimValue,
      potentialRecovery,
      affiliateCode
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Save lead to database
    await db.query(
      `INSERT INTO calculator_leads (email, annual_loss, monthly_loss, monthly_claims, denial_rate, avg_claim_value, potential_recovery, affiliate_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [email, annualLoss, monthlyLoss, monthlyClaims, denialRate, avgClaimValue, potentialRecovery, affiliateCode]
    );

    // Track affiliate conversion if affiliate code exists
    if (affiliateCode) {
      await db.query(
        `UPDATE affiliates 
         SET total_leads_generated = total_leads_generated + 1 
         WHERE affiliate_code = $1`,
        [affiliateCode]
      );
    }

    // Format numbers for email
    const formatCurrency = (value: number) => {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).format(value);
    };

    // Send email report
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Your Dental Denial Report</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0; }
          .content { background: white; padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px; }
          .loss-box { background: #fee2e2; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center; }
          .recovery-box { background: #dcfce7; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center; }
          .button { background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin: 20px 0; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Your Dental Denial Report</h1>
            <p>Based on your calculator inputs</p>
          </div>
          <div class="content">
            <h2>Summary</h2>
            <div class="loss-box">
              <p style="font-size: 14px; margin: 0;">You're losing approximately</p>
              <p style="font-size: 32px; font-weight: bold; margin: 10px 0;">${formatCurrency(annualLoss)}</p>
              <p style="font-size: 14px; margin: 0;">per year to unappealed denials</p>
            </div>

            <h3>Your Inputs:</h3>
            <ul>
              <li><strong>Monthly Claims:</strong> ${monthlyClaims.toLocaleString()}</li>
              <li><strong>Denial Rate:</strong> ${denialRate}%</li>
              <li><strong>Average Claim Value:</strong> ${formatCurrency(avgClaimValue)}</li>
              <li><strong>Monthly Loss:</strong> ${formatCurrency(monthlyLoss)}</li>
            </ul>

            <div class="recovery-box">
              <p style="font-size: 14px; margin: 0;">With DentalAppeal, you could recover</p>
              <p style="font-size: 32px; font-weight: bold; margin: 10px 0; color: #166534;">${formatCurrency(potentialRecovery)}</p>
              <p style="font-size: 14px; margin: 0;">per year by appealing denied claims</p>
            </div>

            <div style="text-align: center;">
              <a href="https://app.dentalappeal.claims/register" class="button">Start Your Free Trial →</a>
            </div>

            <hr style="margin: 30px 0;" />

            <h3>Free Appeal Letter Template</h3>
            <p>Use this template to appeal your next denial:</p>
            <pre style="background: #f1f5f9; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 12px;">
Dear Insurance Company,

RE: Appeal for Claim #[Claim Number]

Patient: [Patient Name]
Service Date: [Date]
Procedure Code: [Code]

This letter is to formally appeal the denial of the above claim.

[Insert clinical justification based on your denial reason]

Please reconsider this claim based on the clinical necessity of the procedure.

Sincerely,
[Practice Name]
[Provider NPI]
            </pre>

            <p>Or, let DentalAppeal write it for you in 30 seconds.</p>
            <div style="text-align: center;">
              <a href="https://app.dentalappeal.claims/register" class="button">Try DentalAppeal Free →</a>
            </div>
          </div>
          <div class="footer">
            <p>DentalAppeal — AI-Powered Insurance Appeals</p>
            <p><a href="https://dentalappeal.claims">dentalappeal.claims</a></p>
            <p style="font-size: 11px;">You received this email because you requested a report from our calculator.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await sendEmail({
      to: email,
      subject: 'Your Dental Denial Revenue Report',
      html
    });

    res.json({ success: true, message: 'Report sent successfully' });
  } catch (error) {
    console.error('Calculator report error:', error);
    res.status(500).json({ error: 'Failed to send report' });
  }
});

// Get calculator stats for admin dashboard
router.get('/calculator/stats', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT 
         COUNT(*) as total_leads,
         COUNT(DISTINCT email) as unique_emails,
         AVG(annual_loss) as avg_annual_loss,
         DATE(created_at) as date
       FROM calculator_leads
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) DESC
       LIMIT 30`
    );
    res.json(rows);
  } catch (error) {
    console.error('Calculator stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
