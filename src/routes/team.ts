import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db';
import { authenticate, requireOwner } from '../middleware/auth';
import { sendTeamInviteEmail } from '../services/email';

// Team accounts for a practice.
//  - owner: manages the team and billing (a practice can have several owners)
//  - staff: everything else
//  - is_dentist (either role): can approve clinical notes
const router = Router();

const INVITE_DAYS = 7;
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const roleLabel = (role: string, isDentist: boolean) =>
  isDentist ? (role === 'owner' ? 'Owner (dentist)' : 'Dentist') : (role === 'owner' ? 'Owner' : 'Staff');

const ownerCount = async (practiceId: number) => {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM users
     WHERE practice_id = $1 AND practice_role = 'owner' AND deleted_at IS NULL AND is_active IS NOT FALSE`,
    [practiceId]
  );
  return (rows as { n: number }[])[0].n;
};

// Members and pending invitations.
router.get('/', authenticate, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId;
    const { rows: members } = await db.query(
      `SELECT id, name, email, COALESCE(practice_role, 'staff') AS practice_role, is_dentist,
              COALESCE(two_factor_enabled, false) AS two_factor_enabled, created_at
       FROM users
       WHERE practice_id = $1 AND deleted_at IS NULL AND is_active IS NOT FALSE
         AND COALESCE(user_type, 'clinic') = 'clinic' AND COALESCE(is_admin, false) = false
       ORDER BY (practice_role = 'owner') DESC, name`,
      [practiceId]
    );
    const { rows: invites } = await db.query(
      `SELECT id, email, name, practice_role, is_dentist, expires_at, created_at
       FROM practice_invites
       WHERE practice_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [practiceId]
    );
    res.json({ members, invites, you: req.user!.userId });
  } catch (error) {
    console.error('Team list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(255).optional(),
  role: z.enum(['owner', 'staff']),
  isDentist: z.boolean().default(false),
});

router.post('/invites', authenticate, requireOwner, async (req, res) => {
  try {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email address and role' });
    const { email, name, role, isDentist } = parsed.data;
    const practiceId = req.user!.practiceId!;

    // Sign-in is by email, so an address can belong to one active account only.
    const { rows: [existing] } = await db.query(
      `SELECT practice_id, deleted_at FROM users WHERE lower(email) = $1 ORDER BY (deleted_at IS NULL) DESC LIMIT 1`,
      [email]
    );
    if (existing && !existing.deleted_at) {
      return res.status(409).json({
        error: existing.practice_id === practiceId
          ? 'This person is already on your team.'
          : 'This email is already used by another DentalAppeal account.',
      });
    }
    if (existing && existing.deleted_at && existing.practice_id !== practiceId) {
      return res.status(409).json({ error: 'This email is already used by another DentalAppeal account.' });
    }

    // A new invite replaces any earlier one for the same address.
    await db.query(
      `UPDATE practice_invites SET revoked_at = NOW()
       WHERE practice_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [practiceId, email]
    );

    const token = crypto.randomBytes(32).toString('hex');
    const { rows: [invite] } = await db.query(
      `INSERT INTO practice_invites (practice_id, email, name, practice_role, is_dentist, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(days => $8))
       RETURNING id, email, name, practice_role, is_dentist, expires_at, created_at`,
      [practiceId, email, name || null, role, isDentist, hashToken(token), req.user!.userId, INVITE_DAYS]
    );

    const { rows: [practice] } = await db.query('SELECT name FROM practices WHERE id = $1', [practiceId]);
    const link = `${process.env.FRONTEND_URL || 'https://app.dentalappeal.claims'}/accept-invite?token=${token}`;
    const sent = await sendTeamInviteEmail(email, req.user!.name || 'Your colleague', practice?.name || 'your practice', roleLabel(role, isDentist), link);

    res.status(201).json({ ...invite, emailSent: sent });
  } catch (error) {
    console.error('Invite error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/invites/:id', authenticate, requireOwner, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      `UPDATE practice_invites SET revoked_at = NOW()
       WHERE id = $1 AND practice_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [req.params.id, req.user!.practiceId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Invitation not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Revoke invite error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const memberSchema = z.object({
  role: z.enum(['owner', 'staff']).optional(),
  isDentist: z.boolean().optional(),
});

router.patch('/members/:id', authenticate, requireOwner, async (req, res) => {
  try {
    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid role' });
    const { role, isDentist } = parsed.data;
    const practiceId = req.user!.practiceId!;

    const { rows: [member] } = await db.query(
      `SELECT id, practice_role FROM users WHERE id = $1 AND practice_id = $2 AND deleted_at IS NULL`,
      [req.params.id, practiceId]
    );
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    if (role === 'staff' && member.practice_role === 'owner' && (await ownerCount(practiceId)) <= 1) {
      return res.status(400).json({ error: 'A practice needs at least one owner. Make someone else an owner first.' });
    }

    const { rows: [updated] } = await db.query(
      `UPDATE users
       SET practice_role = COALESCE($1, practice_role),
           is_dentist = COALESCE($2, is_dentist)
       WHERE id = $3 AND practice_id = $4
       RETURNING id, name, email, practice_role, is_dentist`,
      [role ?? null, isDentist ?? null, member.id, practiceId]
    );
    res.json(updated);
  } catch (error) {
    console.error('Update member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Removing a member signs them out everywhere (authenticate rejects deleted users).
router.delete('/members/:id', authenticate, requireOwner, async (req, res) => {
  try {
    const practiceId = req.user!.practiceId!;
    if (Number(req.params.id) === req.user!.userId) {
      return res.status(400).json({ error: "You can't remove yourself." });
    }
    const { rows: [member] } = await db.query(
      `SELECT id, practice_role FROM users WHERE id = $1 AND practice_id = $2 AND deleted_at IS NULL`,
      [req.params.id, practiceId]
    );
    if (!member) return res.status(404).json({ error: 'Team member not found' });
    if (member.practice_role === 'owner' && (await ownerCount(practiceId)) <= 1) {
      return res.status(400).json({ error: 'A practice needs at least one owner.' });
    }
    await db.query(
      `UPDATE users SET deleted_at = NOW(), is_active = FALSE, two_factor_code = NULL WHERE id = $1`,
      [member.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Accepting an invitation (no sign-in needed) ----------

async function findInvite(token: string) {
  const { rows: [invite] } = await db.query(
    `SELECT i.*, p.name AS practice_name
     FROM practice_invites i JOIN practices p ON p.id = i.practice_id
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > NOW() AND p.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return invite;
}

router.get('/invites/accept/:token', async (req, res) => {
  try {
    const invite = await findInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'This invitation is invalid or has expired. Ask your practice owner for a new one.' });
    res.json({
      email: invite.email,
      name: invite.name,
      practiceName: invite.practice_name,
      roleLabel: roleLabel(invite.practice_role, invite.is_dentist),
    });
  } catch (error) {
    console.error('Invite lookup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const acceptSchema = z.object({
  name: z.string().trim().min(2).max(255),
  password: z.string().min(8).max(200),
});

router.post('/invites/accept/:token', async (req, res) => {
  const client = await db.connect();
  try {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter your name and a password of at least 8 characters' });

    await client.query('BEGIN');
    const { rows: [invite] } = await client.query(
      `SELECT * FROM practice_invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashToken(req.params.token)]
    );
    if (!invite) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This invitation is invalid or has expired. Ask your practice owner for a new one.' });
    }

    const { rows: [taken] } = await client.query(
      `SELECT id, practice_id, deleted_at FROM users WHERE lower(email) = $1 ORDER BY (deleted_at IS NULL) DESC LIMIT 1`,
      [invite.email]
    );
    if (taken && (!taken.deleted_at || taken.practice_id !== invite.practice_id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This email already has a DentalAppeal account. Sign in instead.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    // The invite link proves the email address, so the account starts verified. A member who was
    // removed earlier and is invited back gets their old account reactivated.
    const { rows: [user] } = await client.query(
      `INSERT INTO users (practice_id, email, password_hash, name, role, is_admin, user_type,
                          email_verified, email_verified_at, practice_role, is_dentist, is_active)
       VALUES ($1, $2, $3, $4, 'clinic', false, 'clinic', true, NOW(), $5, $6, true)
       ON CONFLICT (practice_id, email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash, name = EXCLUDED.name,
         email_verified = true, email_verified_at = NOW(),
         practice_role = EXCLUDED.practice_role, is_dentist = EXCLUDED.is_dentist,
         deleted_at = NULL, is_active = true, two_factor_enabled = false
       RETURNING id`,
      [invite.practice_id, invite.email, passwordHash, parsed.data.name, invite.practice_role, invite.is_dentist]
    );
    await client.query('UPDATE practice_invites SET accepted_at = NOW() WHERE id = $1', [invite.id]);
    await client.query('COMMIT');

    res.status(201).json({ success: true, userId: user.id, email: invite.email });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Accept invite error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

export default router;
