// Dental procedure codes. The app accepts any correctly formatted code from either system:
//  - US: ADA CDT codes, "D" + 4 digits (D2740)
//  - Canada: CDA USC&LS codes, 5 digits (27211)
// Which codes exist changes every year, so the format is what we check; the code list
// (cdt_codes table) is used for descriptions only.

export type CodeSystem = 'CDT' | 'USCLS';

const CDT = /^D\d{4}$/;
const USCLS = /^\d{5}$/;

// Uppercase, drop spaces and dashes ("d 2740" -> "D2740"); a bare 4-digit US code gets its D.
export function normalizeCode(raw: string): string {
  const code = String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^\d{4}$/.test(code) ? `D${code}` : code;
}

export function codeSystem(code: string): CodeSystem | null {
  if (CDT.test(code)) return 'CDT';
  if (USCLS.test(code)) return 'USCLS';
  return null;
}

export const isValidCodeFormat = (code: string) => codeSystem(code) !== null;

export const CODE_FORMAT_HELP = 'Use a US code like D2740 or a Canadian code like 27211';

// Descriptions for the given codes from the code table (active rows only). Codes the table
// doesn't have are simply absent; callers fall back to their own short list or the bare code.
export async function lookupCodeDescriptions(codes: string[]): Promise<Record<string, string>> {
  if (!codes.length) return {};
  const { db } = await import('../db');
  const { rows } = await db.query(
    `SELECT code, description FROM cdt_codes
     WHERE code = ANY($1::text[]) AND COALESCE(is_active, true)`,
    [codes.map(normalizeCode)]
  );
  return Object.fromEntries((rows as { code: string; description: string }[]).map((r) => [r.code, r.description]));
}
