import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

export interface ClaimDetails {
  patientName: string;
  patientDob: string;
  insuranceCompany: string;
  policyNumber: string | null;
  claimNumber: string | null;
  procedureCodes: string[];
  denialReason: string;
  serviceDate: string;
  amountClaimed: number | null;
  amountDenied: number | null;
  practiceName: string;
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
}

const DENTAL_SYSTEM_PROMPT = `You are an expert dental insurance appeal specialist. Generate professional appeal letters for dental practices. Be concise but persuasive. Address the specific denial reason. Include clinical justification.`;

export async function generateAppealLetter(
  claim: ClaimDetails,
  practice: PracticeProfile
): Promise<{ letter: string; model: string; promptUsed: string }>
{
  // Using Sonnet (works with your API key)
  const model = 'claude-sonnet-4-6';
  
  // Reduced token limit for faster generation
  const maxTokens = 2048;

  // Build practice letterhead
  const practiceAddress = [
    practice.address,
    practice.city && practice.state && practice.zip 
      ? `${practice.city}, ${practice.state} ${practice.zip}`
      : null
  ].filter(Boolean).join('\n');

  const practicePhone = practice.phone ? `Phone: ${practice.phone}` : '';
  const practiceFax = practice.fax ? `Fax: ${practice.fax}` : '';
  const contactLine = [practicePhone, practiceFax].filter(Boolean).join(' | ');

  const providerInfo = practice.provider_name || 'Treating Dentist';
  const npiInfo = practice.npi_number ? `NPI: ${practice.npi_number}` : '';
  const licenseInfo = practice.provider_license ? `License: ${practice.provider_license}` : '';
  const credentialsLine = [npiInfo, licenseInfo].filter(Boolean).join(' | ');

  // Format procedure codes with descriptions
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

  const procedureList = claim.procedureCodes.map(code => {
    const desc = procedureDescriptions[code] || 'Dental procedure';
    return `${code} — ${desc}`;
  }).join('\n  ');

  const amountClaimed = claim.amountClaimed ? `$${claim.amountClaimed.toFixed(2)}` : 'Amount not provided';
  const amountDenied = claim.amountDenied ? `$${claim.amountDenied.toFixed(2)}` : 'Amount not provided';

  // Shortened prompt for faster processing
  const userPrompt = `Generate a professional dental insurance appeal letter.

PRACTICE INFORMATION:
${practice.name}
${practiceAddress}
${contactLine}
Provider: ${providerInfo}
${credentialsLine}

CLAIM INFORMATION:
Patient: ${claim.patientName}
DOB: ${claim.patientDob}
Insurance: ${claim.insuranceCompany}
Policy: ${claim.policyNumber || 'Not provided'}
Claim #: ${claim.claimNumber || 'Not provided'}
Service Date: ${claim.serviceDate}
Procedure Codes:
  ${procedureList}
Amount Claimed: ${amountClaimed}
Amount Denied: ${amountDenied}
Denial Reason: ${claim.denialReason}

Generate a complete appeal letter with letterhead, date, recipient, clinical justification addressing the denial reason, and signature block. Be concise but professional.`;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: DENTAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const letter = response.content[0]?.type === 'text' ? response.content[0].text : '';

  return { letter, model, promptUsed: userPrompt };
}
