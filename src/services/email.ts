import nodemailer from 'nodemailer';

// Configure email transporter for Hostinger (using correct SMTP)
const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
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

// Send verification email for new registrations
export const sendVerificationEmail = async (email: string, token: string, practiceName: string) => {
  const verificationUrl = `${process.env.BACKEND_URL || 'https://api.dentalappeal.claims'}/api/auth/verify/${token}`;
  
  const subject = 'Verify Your DentalAppeal Account';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your DentalAppeal Account</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          margin: 0;
          padding: 0;
          background-color: #f4f4f4;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        }
        .header {
          background: linear-gradient(135deg, #f8fafc 0%, #ffffff 100%);
          padding: 32px;
          text-align: center;
          border-bottom: 1px solid #e2e8f0;
        }
        .logo-container {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          margin-bottom: 8px;
        }
        .logo {
          width: 48px;
          height: 48px;
          background: linear-gradient(135deg, #1e3a5f, #2563eb);
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .logo-text {
          font-size: 28px;
        }
        .company-name {
          font-size: 24px;
          font-weight: 800;
          background: linear-gradient(135deg, #1e3a5f, #2563eb);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .content {
          padding: 40px 32px;
        }
        .greeting {
          font-size: 24px;
          font-weight: 700;
          color: #1e293b;
          margin-bottom: 16px;
        }
        .message {
          color: #475569;
          line-height: 1.6;
          margin-bottom: 24px;
        }
        .button {
          display: inline-block;
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          color: white;
          padding: 14px 32px;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 600;
          margin: 16px 0;
          box-shadow: 0 2px 4px rgba(37,99,235,0.2);
        }
        .button:hover {
          background: linear-gradient(135deg, #1d4ed8, #1e40af);
        }
        .warning-box {
          background-color: #fef3c7;
          padding: 16px;
          border-radius: 8px;
          margin: 24px 0;
          font-size: 14px;
          border-left: 4px solid #f59e0b;
        }
        .footer {
          text-align: center;
          padding: 24px;
          color: #94a3b8;
          font-size: 12px;
          border-top: 1px solid #e2e8f0;
          background-color: #f8fafc;
        }
        .link-fallback {
          font-size: 12px;
          color: #64748b;
          word-break: break-all;
          background-color: #f1f5f9;
          padding: 12px;
          border-radius: 8px;
          margin-top: 16px;
        }
      </style>
    </head>
    <body>
      <div style="padding: 20px;">
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <div class="logo">
                <span class="logo-text">🦷</span>
              </div>
              <span class="company-name">DentalAppeal</span>
            </div>
          </div>
          <div class="content">
            <div class="greeting">Welcome, ${practiceName}!</div>
            <p class="message">
              Thank you for registering with DentalAppeal. Please verify your email address to activate your account and start managing your insurance appeals.
            </p>
            <div style="text-align: center;">
              <a href="${verificationUrl}" class="button">Verify Email Address</a>
            </div>
            <div class="warning-box">
              <strong>⚠️ This verification link expires in 24 hours.</strong>
            </div>
            <p style="font-size: 14px; color: #475569;">
              If you didn't create an account with DentalAppeal, you can safely ignore this email.
            </p>
            <div class="link-fallback">
              <strong>Can't click the button?</strong><br>
              Copy and paste this link into your browser:<br>
              <a href="${verificationUrl}" style="color: #2563eb;">${verificationUrl}</a>
            </div>
          </div>
          <div class="footer">
            <p><strong>DentalAppeal</strong> — AI-Powered Dental Insurance Appeals</p>
            <p>&copy; 2026 Search Box Strategies. All rights reserved.</p>
            <p><a href="https://app.dentalappeal.claims" style="color: #2563eb; text-decoration: none;">app.dentalappeal.claims</a></p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  
  await sendEmail({ to: email, subject, html });
};

// Send password reset email
export const sendPasswordResetEmail = async (email: string, token: string, name: string) => {
  const resetUrl = `${process.env.FRONTEND_URL || 'https://app.dentalappeal.claims'}/reset-password/${token}`;
  
  const subject = 'Reset Your DentalAppeal Password';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reset Your Password</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; }
        .header { background: linear-gradient(135deg, #1e3a5f, #2563eb); padding: 30px; text-align: center; }
        .header h1 { color: white; margin: 0; }
        .content { padding: 30px; }
        .button { background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 20px 0; }
        .footer { text-align: center; padding: 20px; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; }
        .warning { background-color: #fef3c7; padding: 12px; border-radius: 8px; margin: 20px 0; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔐 DentalAppeal</h1>
        </div>
        <div class="content">
          <h2>Password Reset Request</h2>
          <p>Hello ${name},</p>
          <p>We received a request to reset your password. Click the button below to create a new password.</p>
          <div style="text-align: center;">
            <a href="${resetUrl}" class="button">Reset Password</a>
          </div>
          <div class="warning">
            <strong>⚠️ This link expires in 1 hour.</strong>
          </div>
          <p style="font-size: 14px; color: #6b7280;">
            If you didn't request this, you can safely ignore this email.
          </p>
          <p style="font-size: 14px; color: #6b7280;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
          </p>
        </div>
        <div class="footer">
          <p>DentalAppeal — AI-Powered Dental Insurance Appeals</p>
          <p>&copy; 2026 Search Box Strategies. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  await sendEmail({ to: email, subject, html });
};

// Send appeal status update email
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
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #2563eb; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">DentalAppeal</h1>
      </div>
      <div style="padding: 20px; border: 1px solid #e2e8f0; border-top: none;">
        <h2>Appeal Status Updated</h2>
        <p>The appeal for <strong>${patientName}</strong> has changed status.</p>
        <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Previous Status:</strong> ${statusLabels[oldStatus] || oldStatus}</p>
          <p><strong>New Status:</strong> ${statusLabels[newStatus] || newStatus}</p>
        </div>
        <a href="https://app.dentalappeal.claims/claims/${claimId}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Your Appeal</a>
      </div>
      <div style="text-align: center; padding: 20px; color: #64748b; font-size: 12px;">
        <p>DentalAppeal - AI-Powered Insurance Appeals</p>
        <p><a href="https://app.dentalappeal.claims/settings/notifications" style="color: #2563eb;">Manage email preferences</a></p>
      </div>
    </div>
  `;
  await sendEmail({ to: email, subject, html });
};

// Send payment receipt email
export const sendPaymentReceipt = async (email: string, amount: number, date: Date, subscriptionId: string) => {
  const subject = `Payment Receipt - $${amount}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #10b981; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Payment Confirmed</h1>
      </div>
      <div style="padding: 20px; border: 1px solid #e2e8f0; border-top: none;">
        <h2>Thank you for your payment!</h2>
        <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Amount:</strong> $${amount}</p>
          <p><strong>Date:</strong> ${date.toLocaleDateString()}</p>
          <p><strong>Plan:</strong> Professional Monthly</p>
        </div>
        <a href="https://app.dentalappeal.claims/billing" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Billing History</a>
      </div>
      <div style="text-align: center; padding: 20px; color: #64748b; font-size: 12px;">
        <p>DentalAppeal - AI-Powered Insurance Appeals</p>
      </div>
    </div>
  `;
  await sendEmail({ to: email, subject, html });
};

// Send weekly digest email
export const sendWeeklyDigest = async (email: string, name: string, stats: {
  newClaims: number;
  newAppeals: number;
  wonAppeals: number;
  pendingAppeals: number;
  successRate: number;
}) => {
  const subject = `Your Weekly DentalAppeal Digest`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #2563eb; padding: 20px; text-align: center;">
        <h1 style="color: white; margin: 0;">Weekly Digest</h1>
      </div>
      <div style="padding: 20px; border: 1px solid #e2e8f0; border-top: none;">
        <p>Hello ${name},</p>
        <p>Here's your appeal performance summary for the past week:</p>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin: 20px 0;">
          <div style="background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #2563eb;">${stats.newClaims}</div>
            <div style="font-size: 12px; color: #64748b;">New Claims</div>
          </div>
          <div style="background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #2563eb;">${stats.newAppeals}</div>
            <div style="font-size: 12px; color: #64748b;">New Appeals</div>
          </div>
          <div style="background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #2563eb;">${stats.wonAppeals}</div>
            <div style="font-size: 12px; color: #64748b;">Won This Week</div>
          </div>
          <div style="background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 24px; font-weight: bold; color: #2563eb;">${stats.pendingAppeals}</div>
            <div style="font-size: 12px; color: #64748b;">Pending Review</div>
          </div>
        </div>
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://app.dentalappeal.claims/analytics" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Full Analytics</a>
        </div>
      </div>
      <div style="text-align: center; padding: 20px; color: #64748b; font-size: 12px;">
        <p>DentalAppeal - AI-Powered Insurance Appeals</p>
      </div>
    </div>
  `;
  await sendEmail({ to: email, subject, html });
};
