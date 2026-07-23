import { db } from '../db';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

async function setupAdmin() {
  const ADMIN_EMAIL = 'adrien@searchboxstrategies.com';
  const ADMIN_PASSWORD = 'M1gu3l+R3g1s';
  
  console.log('🔧 Starting Admin Setup...');
  console.log(`📧 Admin Email: ${ADMIN_EMAIL}`);
  
  try {
    // Connect to database
    await db.connect();
    console.log('✅ Database connected');
    
    // First, remove any existing admin accounts
    const deleteResult = await db.query(
      'DELETE FROM users WHERE is_admin = true AND email != $1',
      [ADMIN_EMAIL]
    );
    console.log(`✅ Removed ${deleteResult.rowCount} existing admin(s)`);
    
    // Hash password
    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
    console.log('✅ Password hashed');
    
    // Generate 2FA code for initial setup
    const twoFactorCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeExpires = new Date(Date.now() + 10 * 60 * 1000);
    console.log(`📧 2FA Code: ${twoFactorCode} (expires in 10 min)`);
    
    // Check if admin exists
    const { rows: [existingAdmin] } = await db.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [ADMIN_EMAIL]
    );
    
    if (existingAdmin) {
      console.log(`📝 Updating existing user: ${existingAdmin.email}`);
      
      // Update existing user to admin
      const result = await db.query(
        `UPDATE users 
         SET is_admin = true,
             role = 'admin',
             password_hash = $1,
             email_verified = true,
             email_verified_at = NOW(),
             two_factor_enabled = true,
             two_factor_code = $2,
             two_factor_expires = $3,
             verification_token = NULL,
             verification_token_expires = NULL
         WHERE id = $4
         RETURNING id, email, name, is_admin, two_factor_enabled`,
        [hashedPassword, twoFactorCode, codeExpires, existingAdmin.id]
      );
      
      const admin = result.rows[0];
      console.log(`✅ Admin updated: ${admin.email} (ID: ${admin.id})`);
      console.log(`✅ 2FA Enabled: ${admin.two_factor_enabled}`);
    } else {
      console.log('📝 Creating new admin user...');
      
      // Create practice first
      const { rows: [practice] } = await db.query(
        `INSERT INTO practices (name, email, subscription_status)
         VALUES ('Admin Practice', $1, 'active')
         RETURNING id`,
        [ADMIN_EMAIL]
      );
      console.log(`✅ Practice created: ${practice.id}`);
      
      // Create admin user
      const result = await db.query(
        `INSERT INTO users (
          email, password_hash, name, role, is_admin,
          practice_id, email_verified, email_verified_at,
          two_factor_enabled, two_factor_code, two_factor_expires
        ) VALUES ($1, $2, $3, 'admin', true, $4, true, NOW(), true, $5, $6)
        RETURNING id, email, name, is_admin, two_factor_enabled`,
        [ADMIN_EMAIL, hashedPassword, 'Adrien', practice.id, twoFactorCode, codeExpires]
      );
      
      const admin = result.rows[0];
      console.log(`✅ Admin created: ${admin.email} (ID: ${admin.id})`);
      console.log(`✅ 2FA Enabled: ${admin.two_factor_enabled}`);
    }
    
    // Create trigger to prevent multiple admins
    await db.query(`
      CREATE OR REPLACE FUNCTION ensure_single_admin()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.is_admin = true AND 
           (SELECT COUNT(*) FROM users WHERE is_admin = true AND id != NEW.id) > 0 THEN
          RAISE EXCEPTION 'Only one admin account is allowed';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      
      DROP TRIGGER IF EXISTS prevent_multiple_admins ON users;
      CREATE TRIGGER prevent_multiple_admins
        BEFORE INSERT OR UPDATE OF is_admin ON users
        FOR EACH ROW
        EXECUTE FUNCTION ensure_single_admin();
    `);
    console.log('✅ Admin trigger created - only one admin allowed');
    
    // Verify setup
    const { rows: admins } = await db.query(
      'SELECT id, email, name, is_admin, role, two_factor_enabled, email_verified FROM users WHERE is_admin = true'
    );
    
    console.log('\n📊 Admin Summary:');
    console.log('─────────────────────────────────');
    admins.forEach((admin: any, index: number) => {
      console.log(`Admin ${index + 1}:`);
      console.log(`  ID: ${admin.id}`);
      console.log(`  Email: ${admin.email}`);
      console.log(`  Name: ${admin.name}`);
      console.log(`  is_admin: ${admin.is_admin}`);
      console.log(`  role: ${admin.role}`);
      console.log(`  2FA Enabled: ${admin.two_factor_enabled}`);
      console.log(`  Email Verified: ${admin.email_verified}`);
      console.log('─────────────────────────────────');
    });
    
    console.log(`\n🎯 Admin setup complete!`);
    console.log(`📧 2FA Code: ${twoFactorCode} (use this to login)`);
    console.log(`🔐 Admin credentials:`);
    console.log(`   Email: ${ADMIN_EMAIL}`);
    console.log(`   Password: ${ADMIN_PASSWORD}`);
    console.log(`   TFA Code: ${twoFactorCode}`);
    console.log('\n⚠️  IMPORTANT: This 2FA code expires in 10 minutes!');
    console.log('💡 Use this code to login to the admin portal.');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Admin setup failed:', error);
    process.exit(1);
  }
}

setupAdmin();
