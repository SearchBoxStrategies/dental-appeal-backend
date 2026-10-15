import { db } from '../db';

// Supabase's Free plan pauses a project after a week without database activity, which takes the
// app down. Updating one row is a real write, so it counts as activity.
export async function touchHeartbeat(source: 'api' | 'external'): Promise<Date> {
  const { rows } = await db.query(
    `INSERT INTO system_heartbeat (id, pinged_at, source) VALUES (1, NOW(), $1)
     ON CONFLICT (id) DO UPDATE SET pinged_at = NOW(), source = EXCLUDED.source
     RETURNING pinged_at`,
    [source]
  );
  return (rows as { pinged_at: Date }[])[0].pinged_at;
}

// Runs inside the API process: shortly after start-up, then every 6 hours.
export function scheduleHeartbeat() {
  const run = () => touchHeartbeat('api').catch((err) => console.error('Heartbeat failed:', err));
  setTimeout(run, 30_000).unref();
  setInterval(run, 6 * 60 * 60_000).unref();
}
