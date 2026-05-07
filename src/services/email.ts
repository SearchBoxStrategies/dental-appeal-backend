import nodemailer from 'nodemailer';

// Configure email transporter for Hostinger (Titan Email)
const transporter = nodemailer.createTransport({
  host: "smtp.titan.email",
  port: 465,
  secure: true,
  auth: {
    user: "support@dentalappeal.claims",
    pass: process.env.SMTP_PASS,
  },
});

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const sendEmail = async (options: EmailOptions) => {
  try {
    await transporter.sendMail({
      from: `"DentalAppeal Support" <support@dentalappeal.claims>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    console.log(`📧 Email sent to ${options.to}`);
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
};

// Notification templates
export const sendAppealStatusUpdate = async (email: string, patientName: string, oldStatus: string, newStatus: string, claimId: number) => {
  const statusLabels: Record<string, string> = {
    draft: 'Draft',
    appealed: 'Appeal Sent',
    under_review: 'Under Review',
    won: 'Won',
    lost: 'Lost',
    paid: 'Paid'
  };
  
  const subject = `Appeal Status Update - ${patientName}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Appeal Status Update</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background-color: #2563eb; padding: 20px; text-align: center; }
        .header h1 { color: white; margin: 0; font-size: 24px; }
        .content { padding: 30px; }
        .status-box { background-color: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .button { background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; }
        .footer { text-align: center; padding: 20px; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🦷 DentalAppeal</h1>
        </div>
        <div class="content">
          <h2>Appeal Status Update</h2>
          <p>The appeal for <strong>${patientName}</strong> has been updated.</p>
          <div class="status-box">
            <p><strong>Previous Status:</strong> ${statusLabels[oldStatus] || oldStatus}</p>
            <p><strong>New Status:</strong> ${statusLabels[newStatus] || newStatus}</p>
          </div>
          <a href="https://app.dentalappeal.claims/claims/${claimId}" class="button">View Your Appeal</a>
        </div>
        <div class="footer">
          <p>DentalAppeal - AI-Powered Insurance Appeals</p>
          <p><a href="https://app.dentalappeal.claims/settings/notifications" style="color: #2563eb;">Manage email preferences</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
  await sendEmail({ to: email, subject, html });
};

export const sendPaymentReceipt = async (email: string, amount: number, date: Date, subscriptionId: string) => {
  const subject = `Payment Receipt - $${amount}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Payment Receipt</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
        .header { background-color: #10b981; padding: 20px; text-align: center; }
        .header h1 { color: white; margin: 0; }
        .content { padding: 30px; }
        .receipt-box { background-color: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .button { background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; }
        .footer { text-align: center; padding: 20px; color: #64748b; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>✅ Payment Confirmed</h1>
        </div>
        <div class="content">
          <h2>Thank you for your payment!</h2>
          <div class="receipt-box">
            <p><strong>Amount:</strong> $${amount}</p>
            <p><strong>Date:</strong> ${date.toLocaleDateString()}</p>
            <p><strong>Plan:</strong> Professional Monthly</p>
            <p><strong>Invoice #:</strong> ${subscriptionId}</p>
          </div>
          <a href="https://app.dentalappeal.claims/billing" class="button">View Billing History</a>
        </div>
        <div class="footer">
          <p>DentalAppeal - AI-Powered Insurance Appeals</p>
        </div>
      </div>
    </body>
    </html>
  `;
  await sendEmail({ to: email, subject, html });
};

export const sendWeeklyDigest = async (email: string, name: string, stats: {
  newClaims: number;
  newAppeals: number;
  wonAppeals: number;
  pendingAppeals: number;
  successRate: number;
}) => {
  const subject = `Your Weekly DentalAppeal Digest`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Weekly Digest</title>
      <style>
        body { font-family: Arial, sans-serif; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 0 auto; background: white; }
        .header { background: #2563eb; padding: 20px; text-align: center; }
        .header h1 { color: white; }
        .content { padding: 30px; }
        .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin: 20px 0; }
        .stat-card { background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; color: #2563eb; }
        .stat-label { font-size: 12px; color: #64748b; }
        .footer { text-align: center; padding: 20px; color: #64748b; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📊 Your Weekly Digest</h1>
        </div>
        <div class="content">
          <p>Hello ${name},</p>
          <p>Here's your appeal performance summary for the past week:</p>
          <div class="stats">
            <div class="stat-card">
              <div class="stat-value">${stats.newClaims}</div>
              <div class="stat-label">New Claims</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.newAppeals}</div>
              <div class="stat-label">New Appeals</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.wonAppeals}</div>
              <div class="stat-label">Won This Week</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${stats.pendingAppeals}</div>
              <div class="stat-label">Pending Review</div>
            </div>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="https://app.dentalappeal.claims/analytics" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Full Analytics</a>
          </div>
        </div>
        <div class="footer">
          <p>DentalAppeal - AI-Powered Insurance Appeals</p>
        </div>
      </div>
    </body>
    </html>
  `;
  await sendEmail({ to: email, subject, html });
};
