import { db } from '../db';
import { sendAppealReminderEmail, ReminderClaim } from '../services/email';

// Emails each practice a digest of:
//  - appeal deadlines within 14 days (again at 3 days out), for claims not yet appealed
//  - appeals sent 30+ days ago with no outcome (again every 30 days)
// Safe to run as often as you like: each claim is stamped when it is included.

const LOCK_ID = 740_211; // pg advisory lock so two runs never overlap

export async function processAppealReminders(): Promise<{ practices: number; claims: number }> {
  const conn = await db.connect();
  try {
    const { rows: [lock] } = await conn.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!lock.ok) return { practices: 0, claims: 0 };

    try {
      const { rows: deadlines } = await conn.query(
        `SELECT c.id, c.practice_id, c.insurance_company, c.amount_denied,
                to_char(c.appeal_deadline, 'YYYY-MM-DD') AS appeal_deadline,
                (c.appeal_deadline - CURRENT_DATE)::int AS days_left
         FROM claims c
         JOIN practices p ON p.id = c.practice_id AND p.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
           AND c.status IN ('pending', 'draft')
           AND c.appeal_deadline BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE + 14
           AND (
             c.deadline_reminder_sent_at IS NULL
             OR (c.appeal_deadline - CURRENT_DATE <= 3
                 AND c.deadline_reminder_sent_at::date < c.appeal_deadline - 3)
           )
         ORDER BY c.appeal_deadline`
      );

      const { rows: followUps } = await conn.query(
        `SELECT c.id, c.practice_id, c.insurance_company, c.amount_denied,
                (CURRENT_DATE - c.appealed_at::date)::int AS days_since_appeal
         FROM claims c
         JOIN practices p ON p.id = c.practice_id AND p.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
           AND c.status IN ('appealed', 'under_review')
           AND c.appealed_at <= NOW() - INTERVAL '30 days'
           AND (c.follow_up_reminder_sent_at IS NULL
                OR c.follow_up_reminder_sent_at <= NOW() - INTERVAL '30 days')
         ORDER BY c.appealed_at`
      );

      const byPractice = new Map<number, { deadlines: ReminderClaim[]; followUps: ReminderClaim[] }>();
      const bucket = (practiceId: number) => {
        if (!byPractice.has(practiceId)) byPractice.set(practiceId, { deadlines: [], followUps: [] });
        return byPractice.get(practiceId)!;
      };
      deadlines.forEach((c) => bucket(c.practice_id).deadlines.push(c));
      followUps.forEach((c) => bucket(c.practice_id).followUps.push(c));

      let practices = 0;
      let claims = 0;
      for (const [practiceId, group] of byPractice) {
        const { rows: users } = await conn.query(
          `SELECT email, name FROM users
           WHERE practice_id = $1 AND deleted_at IS NULL AND is_active IS NOT FALSE
             AND COALESCE(user_type, 'clinic') <> 'affiliate' AND COALESCE(is_admin, false) = false`,
          [practiceId]
        );
        let delivered = false;
        for (const user of users) {
          if (await sendAppealReminderEmail(user.email, user.name, group.deadlines, group.followUps)) {
            delivered = true;
          }
        }
        // Stamp only after a successful send, so a mail outage retries on the next run.
        if (!delivered) continue;
        if (group.deadlines.length) {
          await conn.query('UPDATE claims SET deadline_reminder_sent_at = NOW() WHERE id = ANY($1::int[])',
            [group.deadlines.map((c) => c.id)]);
        }
        if (group.followUps.length) {
          await conn.query('UPDATE claims SET follow_up_reminder_sent_at = NOW() WHERE id = ANY($1::int[])',
            [group.followUps.map((c) => c.id)]);
        }
        practices++;
        claims += group.deadlines.length + group.followUps.length;
      }

      if (practices) console.log(`⏰ Appeal reminders sent to ${practices} practice(s) for ${claims} claim(s)`);
      return { practices, claims };
    } finally {
      await conn.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    conn.release();
  }
}

// Runs inside the API process: shortly after start-up, then every 6 hours.
export function scheduleAppealReminders() {
  if (process.env.APPEAL_REMINDERS === 'off') return;
  const run = () => processAppealReminders().catch((err) => console.error('Appeal reminders failed:', err));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 60 * 60_000).unref();
}
