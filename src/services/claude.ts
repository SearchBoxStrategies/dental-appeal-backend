import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// One model for letters, notes and reading denial notices. Override with CLAUDE_MODEL.
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

// If the model declines a request, the API retries it on a fallback model in the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ClaudeError extends Error {}

interface CallOptions {
  system: string;
  content: Anthropic.ContentBlockParam[] | string;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  // JSON schema for structured output; the reply is then a single JSON object.
  jsonSchema?: Record<string, unknown>;
}

async function callClaude({ system, content, maxTokens, effort, jsonSchema }: CallOptions) {
  const outputConfig: Record<string, unknown> = { effort };
  if (jsonSchema) outputConfig.format = { type: 'json_schema', schema: jsonSchema };

  // output_config and fallbacks are newer than the installed SDK's types; the SDK sends them as-is.
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: outputConfig,
    fallbacks: 'default',
  } as unknown as Anthropic.MessageCreateParamsNonStreaming;

  const started = Date.now();
  const response = await client.messages.create(body, {
    headers: { 'anthropic-beta': FALLBACK_BETA },
  });
  console.log(`✅ Claude ${response.model} replied in ${Date.now() - started}ms`);

  const stopReason = response.stop_reason as string;
  if (stopReason === 'refusal') {
    throw new ClaudeError('The AI declined this request. Please review the claim details and try again.');
  }
  if (stopReason === 'max_tokens') {
    throw new ClaudeError('The AI reply was cut off. Please try again.');
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text) throw new ClaudeError('The AI returned an empty reply. Please try again.');

  return { text, model: response.model || MODEL };
}

export interface ClaimDetails {
  patientName: string;
  patientDob: string;
  insuranceCompany: string;
  insuranceCompanyId?: number;
  policyNumber: string | null;
  claimNumber: string | null;
  procedureCodes: string[];
  denialReason: string;
  serviceDate: string;
  amountClaimed: number | null;
  amountDenied: number | null;
  practiceName: string;
  denialDate?: string | null;
  // Clinical narrative the dentist approved; the letter's strongest evidence.
  dentistNote?: string | null;
  dentistNoteApprovedBy?: string | null;
  // Documents the clinic is enclosing with the appeal.
  enclosures?: string[];
}

export interface PracticeProfile {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  website: string | null;
  email: string | null;
  npi_number: string | null;
  tax_id: string | null;
  provider_name: string | null;
  provider_license: string | null;
  insuranceCompany?: {
    id: number;
    name: string;
    code: string;
    appeals_address: string;
    appeals_department: string;
    timely_filing_days: number;
  } | null;
}

const procedureDescriptions: Record<string, string> = {
  D0120: 'Periodic oral evaluation',
  D0140: 'Limited oral evaluation',
  D0210: 'Complete series of x-rays',
  D0220: 'Periapical x-ray',
  D0270: 'Bitewing x-ray',
  D0330: 'Panoramic x-ray',
  D1110: 'Prophylaxis - adult',
  D1120: 'Prophylaxis - child',
  D1206: 'Topical fluoride varnish',
  D1351: 'Sealant',
  D2140: 'Amalgam - one surface',
  D2150: 'Amalgam - two surfaces',
  D2160: 'Amalgam - three surfaces',
  D2330: 'Composite - one surface, anterior',
  D2331: 'Composite - two surfaces, anterior',
  D2332: 'Composite - three surfaces, anterior',
  D2391: 'Composite - one surface, posterior',
  D2392: 'Composite - two surfaces, posterior',
  D2393: 'Composite - three surfaces, posterior',
  D2394: 'Composite - four+ surfaces, posterior',
  D2740: 'Crown - porcelain/ceramic',
  D2750: 'Crown - porcelain fused to metal',
  D3310: 'Root canal - anterior',
  D3320: 'Root canal - bicuspid',
  D3330: 'Root canal - molar',
  D4341: 'Periodontal scaling and root planing',
  D4355: 'Full mouth debridement',
  D4910: 'Periodontal maintenance',
  D5110: 'Complete denture - upper',
  D5120: 'Complete denture - lower',
  D5211: 'Partial denture - upper',
  D5212: 'Partial denture - lower',
  D6010: 'Surgical placement of implant',
  D6056: 'Prefabricated abutment',
  D7140: 'Extraction - simple',
  D7210: 'Extraction - surgical',
  D7240: 'Extraction - impacted',
  D9110: 'Palliative treatment'
};

const describeCodes = (codes: string[]) =>
  codes.map((code) => `${code} — ${procedureDescriptions[code] || 'Dental procedure'}`).join('\n  ');

const money = (amount: number | null) => (amount != null ? `$${amount.toFixed(2)}` : 'Not provided');

// ============================================
// APPEAL LETTER
// ============================================

const LETTER_SYSTEM_PROMPT = `You write dental insurance appeal letters for dental clinics in the United States and Canada. The clinic's office staff will review your letter, then the dentist signs it and it is mailed or faxed to the insurer.

What wins dental appeals:
- Answer the insurer's specific denial reason directly, in the first paragraph after the subject line. Name the denial code if one is given.
- Support medical necessity with the clinical facts provided: diagnosis, tooth numbers, findings, history, and why the treatment was the appropriate standard of care.
- Refer to the enclosed evidence by name (x-rays, periodontal charting, photos, narrative).
- Cite the plan or policy only in general terms ("the patient's plan benefits for this procedure"); never invent policy clause numbers, statutes or guidelines.
- Ask for a specific outcome: reprocess the claim and pay the stated amount.
- Keep it to one page where possible. Professional, firm, not emotional.

Rules:
- Use only the facts provided. Never invent clinical findings, measurements, dates, tooth numbers or history. Where the letter needs a fact you do not have, write a short placeholder in square brackets, such as [tooth number] or [pocket depths], so the clinic fills it in before sending.
- Do not include the practice letterhead (name, address, phone); the app prints it above your letter. Start with the date line.
- Plain text only: no markdown, no asterisks, no headings with # symbols.`;

export async function generateAppealLetter(
  claim: ClaimDetails,
  practice: PracticeProfile
): Promise<{ letter: string; model: string; promptUsed: string }> {
  const providerName = practice.provider_name || '[Treating dentist name]';
  const credentials = [
    practice.npi_number ? `NPI: ${practice.npi_number}` : '',
    practice.provider_license ? `License: ${practice.provider_license}` : '',
  ].filter(Boolean).join(' | ');

  const insurerAddress = practice.insuranceCompany
    ? [practice.insuranceCompany.appeals_department, practice.insuranceCompany.appeals_address]
        .filter(Boolean).join('\n')
    : '';

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const dentistNote = claim.dentistNote?.trim()
    ? `${claim.dentistNote.trim()}\n(Approved by ${claim.dentistNoteApprovedBy || 'the treating dentist'})`
    : 'None provided. Use bracketed placeholders for clinical facts the letter needs.';

  const enclosures = claim.enclosures?.length
    ? claim.enclosures.map((item) => `- ${item}`).join('\n')
    : '- Copy of the denial (EOB)\n- [List the x-rays, charting or photos you are enclosing]';

  const userPrompt = `Write the appeal letter for this denied claim.

TODAY'S DATE: ${today}

PRACTICE
${practice.name}
Treating dentist: ${providerName}
${credentials}

INSURER
${claim.insuranceCompany}
${insurerAddress ? `Appeals address:\n${insurerAddress}` : 'Appeals address: not on file (use a bracketed placeholder)'}

CLAIM
Patient: ${claim.patientName}
Date of birth: ${claim.patientDob}
Policy / member ID: ${claim.policyNumber || 'Not provided'}
Claim number: ${claim.claimNumber || 'Not provided'}
Date of service: ${claim.serviceDate}
${claim.denialDate ? `Date of denial: ${claim.denialDate}\n` : ''}Procedures:
  ${describeCodes(claim.procedureCodes)}
Amount billed: ${money(claim.amountClaimed)}
Amount denied: ${money(claim.amountDenied)}

DENIAL REASON (from the insurer)
${claim.denialReason}

DENTIST'S CLINICAL NOTE
${dentistNote}

ENCLOSURES
${enclosures}

Format: date line, insurer name and appeals address, "RE:" block with patient, date of birth, member ID, claim number and date of service, salutation, body, request for reprocessing, closing, signature block for ${providerName}${credentials ? ` with ${credentials}` : ''}, then an "Enclosures:" list.`;

  const { text, model } = await callClaude({
    system: LETTER_SYSTEM_PROMPT,
    content: userPrompt,
    maxTokens: 16000,
    effort: 'high',
  });

  return { letter: text, model, promptUsed: userPrompt };
}

// ============================================
// DENTIST NOTE (clinical narrative for sign-off)
// ============================================

const NOTE_SYSTEM_PROMPT = `You draft clinical narratives for dental insurance appeals. The treating dentist reviews, corrects and approves your draft before it is used, so accuracy matters more than polish.

Write the narrative in the first person as the treating dentist, in the style of a chart note an insurance reviewer expects: diagnosis, clinical and radiographic findings, history, treatment provided, and why it was necessary.

Never invent clinical facts. Every finding, measurement, tooth number, date or history item you do not have must be a placeholder in square brackets that tells the dentist what to fill in, such as [pocket depths, e.g. 5-6 mm on teeth #2-#5] or [date of prior crown placement]. Focus the narrative on what this denial reason needs to be overturned.

Plain text, 120 to 250 words, no headings, no markdown.`;

export async function draftDentistNote(claim: {
  procedureCodes: string[];
  denialReason: string;
  serviceDate: string;
  insuranceCompany: string;
  checklist: string[];
}): Promise<{ note: string; model: string }> {
  const prompt = `Draft the clinical narrative for this appeal.

Insurer: ${claim.insuranceCompany}
Date of service: ${claim.serviceDate}
Procedures:
  ${describeCodes(claim.procedureCodes)}

Denial reason:
${claim.denialReason}

Evidence the clinic is gathering:
${claim.checklist.map((item) => `- ${item}`).join('\n')}`;

  const { text, model } = await callClaude({
    system: NOTE_SYSTEM_PROMPT,
    content: prompt,
    maxTokens: 8000,
    effort: 'medium',
  });
  return { note: text, model };
}

// ============================================
// READ A DENIAL NOTICE (EOB)
// ============================================

const nullable = (type: 'string' | 'number') => ({ anyOf: [{ type }, { type: 'null' }] });

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isDenialNotice', 'patientName', 'patientDob', 'insuranceCompany', 'policyNumber',
    'claimNumber', 'serviceDate', 'denialDate', 'procedureCodes', 'amountClaimed',
    'amountDenied', 'denialReason', 'uncertainFields',
  ],
  properties: {
    isDenialNotice: { type: 'boolean' },
    patientName: nullable('string'),
    patientDob: nullable('string'),
    insuranceCompany: nullable('string'),
    policyNumber: nullable('string'),
    claimNumber: nullable('string'),
    serviceDate: nullable('string'),
    denialDate: nullable('string'),
    procedureCodes: { type: 'array', items: { type: 'string' } },
    amountClaimed: nullable('number'),
    amountDenied: nullable('number'),
    denialReason: nullable('string'),
    uncertainFields: { type: 'array', items: { type: 'string' } },
  },
};

const extractionResult = z.object({
  isDenialNotice: z.boolean(),
  patientName: z.string().nullable(),
  patientDob: z.string().nullable(),
  insuranceCompany: z.string().nullable(),
  policyNumber: z.string().nullable(),
  claimNumber: z.string().nullable(),
  serviceDate: z.string().nullable(),
  denialDate: z.string().nullable(),
  procedureCodes: z.array(z.string()),
  amountClaimed: z.number().nullable(),
  amountDenied: z.number().nullable(),
  denialReason: z.string().nullable(),
  uncertainFields: z.array(z.string()),
});

export type ExtractedClaim = z.infer<typeof extractionResult>;

const EXTRACTION_SYSTEM_PROMPT = `You read dental insurance denial notices: Explanation of Benefits (EOB) statements, remittance advice and denial letters from US and Canadian dental insurers. Extract the fields of the denied claim exactly as printed.

- Dates: return YYYY-MM-DD. If a date is ambiguous or unreadable, return null and list the field in uncertainFields.
- procedureCodes: the CDA or ADA CDT codes of the denied or reduced lines only, e.g. "D2740". Prefix US codes with "D" if the document omits it. Canadian 5-digit codes stay as printed.
- amountClaimed: total submitted for those lines. amountDenied: the amount not paid on those lines.
- denialReason: the insurer's explanation in full, including remark or reason codes and their text, e.g. "Code 147: Frequency limitation - benefit allowed once every 5 years".
- uncertainFields: names of fields you could not read clearly or had to infer.
- If there are several patients or claims, use the first denied claim and add "multipleClaims" to uncertainFields.
- If the document is not a dental insurance denial or EOB, set isDenialNotice to false and the other fields to null or empty.
- Never guess a value that is not on the document; use null.`;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export async function extractClaimFromDocument(file: { buffer: Buffer; mimetype: string }): Promise<ExtractedClaim> {
  const data = file.buffer.toString('base64');
  const mime = file.mimetype === 'image/jpg' ? 'image/jpeg' : file.mimetype;

  let documentBlock: Anthropic.ContentBlockParam;
  if (mime === 'application/pdf') {
    documentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  } else if ((IMAGE_TYPES as readonly string[]).includes(mime)) {
    documentBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mime as (typeof IMAGE_TYPES)[number], data },
    };
  } else {
    throw new ClaudeError('Upload a PDF, JPG or PNG of the denial notice.');
  }

  const { text } = await callClaude({
    system: EXTRACTION_SYSTEM_PROMPT,
    content: [documentBlock, { type: 'text', text: 'Extract the denied claim from this document.' }],
    maxTokens: 8000,
    effort: 'medium',
    jsonSchema: EXTRACTION_SCHEMA,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new ClaudeError('Could not read the document. Please enter the claim by hand.');
  }
  const result = extractionResult.safeParse(parsed);
  if (!result.success) {
    throw new ClaudeError('Could not read the document. Please enter the claim by hand.');
  }
  return result.data;
}
