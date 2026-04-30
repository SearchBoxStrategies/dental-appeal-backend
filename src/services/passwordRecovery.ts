import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { db } from '../db';

// Generate reset token
export const createResetToken = () => {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const tokenExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
    
    return { resetToken, hashedToken, tokenExpiry };
};

// Save token to database
export const saveResetToken = async (email: string, hashedToken: string, expires: number) => {
    const result = await db.query(
        'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE email = $3 RETURNING id',
        [hashedToken, expires, email]
    );
    return result.rows[0];
};

// Send reset email
export const sendResetEmail = async (email: string, resetToken: string) => {
    const resetUrl = `http://localhost:5173/reset-password/${resetToken}`;
    
    // For development, just log the URL (no actual email sending yet)
    console.log(`\n=================================`);
    console.log(`PASSWORD RESET LINK FOR ${email}:`);
    console.log(resetUrl);
    console.log(`This link expires in 10 minutes`);
    console.log(`=================================\n`);
    
    // Optional: Configure real email later
    return true;
};

// Verify reset token
export const verifyResetToken = async (token: string) => {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    const result = await db.query(
        'SELECT id, email FROM users WHERE reset_password_token = $1 AND reset_password_expires > $2',
        [hashedToken, Date.now()]
    );
    
    return result.rows[0];
};

// Update password and clear reset token
export const updatePassword = async (userId: number, hashedPassword: string) => {
    await db.query(
        'UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
        [hashedPassword, userId]
    );
};