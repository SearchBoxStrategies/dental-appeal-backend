// Load an official procedure code file into the cdt_codes table.
//
//   node dist/scripts/importProcedureCodes.js --file codes.csv --system CDT --edition 2027
//   node dist/scripts/importProcedureCodes.js --file uscls.csv --system USCLS --edition 2027 --dry-run
//
// The CSV needs the columns code, category and description (other columns are ignored).
// Codes in the file are added or updated; codes of the same system that are missing from the
// file are marked inactive (retired) rather than deleted, so older claims still show them.
// Uses DATABASE_URL from the environment. Run once a year when the new edition is out.
import 'dotenv/config';
import fs from 'fs';
import csv from 'csv-parser';
import { db } from '../db';
import { normalizeCode, codeSystem, CodeSystem } from '../utils/procedureCodes';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readCsv(file: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    fs.createReadStream(file)
      .pipe(csv({ mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim().toLowerCase() }))
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

async function main() {
  const file = arg('file');
  const system = arg('system') as CodeSystem | undefined;
  const edition = arg('edition');
  const dryRun = process.argv.includes('--dry-run');

  if (!file || !system || !edition || !['CDT', 'USCLS'].includes(system)) {
    console.error('Usage: --file <codes.csv> --system CDT|USCLS --edition <year> [--dry-run]');
    process.exit(1);
  }

  const rows = await readCsv(file);
  const codes = new Map<string, { category: string; description: string }>();
  const problems: string[] = [];

  rows.forEach((row, i) => {
    const code = normalizeCode(row.code || '');
    const description = (row.description || '').trim();
    const category = (row.category || '').trim() || 'Other';
    if (codeSystem(code) !== system) problems.push(`line ${i + 2}: "${row.code}" is not a ${system} code`);
    else if (!description) problems.push(`line ${i + 2}: ${code} has no description`);
    else codes.set(code, { category, description });
  });

  console.log(`${file}: ${rows.length} rows, ${codes.size} valid ${system} codes, ${problems.length} problems`);
  problems.slice(0, 20).forEach((p) => console.log(`  ${p}`));
  if (problems.length > 20) console.log(`  ...and ${problems.length - 20} more`);
  if (codes.size === 0) {
    console.error('Nothing to import.');
    process.exit(1);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [code, { category, description }] of codes) {
      await client.query(
        `INSERT INTO cdt_codes (code, category, description, system, edition, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
         ON CONFLICT (code) DO UPDATE SET
           category = EXCLUDED.category, description = EXCLUDED.description,
           system = EXCLUDED.system, edition = EXCLUDED.edition, is_active = TRUE, updated_at = NOW()`,
        [code, category, description, system, edition]
      );
    }
    const { rowCount: retired } = await client.query(
      `UPDATE cdt_codes SET is_active = FALSE, updated_at = NOW()
       WHERE system = $1 AND is_active AND NOT (code = ANY($2::text[]))`,
      [system, [...codes.keys()]]
    );
    console.log(`${codes.size} codes added or updated, ${retired} retired (marked inactive).`);

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('Dry run: nothing was saved.');
    } else {
      await client.query('COMMIT');
      console.log(`Saved ${system} ${edition}.`);
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error('Import failed:', error);
  process.exit(1);
});
