import { Pool, types } from 'pg';

// Return DATE columns (date of birth, service date) as plain 'YYYY-MM-DD' strings. By default
// pg turns them into timestamps at midnight, which show up a day early in North American time
// zones and print as "Tue Jan 01 1980 00:00:00 GMT" in appeal letter prompts.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (value: string) => value);

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});
