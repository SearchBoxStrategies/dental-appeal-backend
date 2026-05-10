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

const DENTAL_SYSTEM_PROMPT = `You are an expert dental insurance appeal specialist with deep knowledge of:
- ADA (American Dental Association) procedure codes (CDT codes)
- Common dental insurance denial reasons and effective appeal strategies
- Medical necessity documentation requirements
- Insurance policy language and coverage interpretations
- HIPAA-compliant professional correspondence

Generate professional, persuasive insurance appeal letters for dental practices. Each letter must:
1. Directly address the specific denial reason with clinical justification
2. Cite relevant CDT codes and their clinical necessity
3. Reference applicable insurance policy provisions
4. Include a clear, specific request for reconsideration
5. Maintain a formal, assertive professional tone
6. Follow standard business letter format with proper letterhead

CDT CODE REFERENCE:
- D0120-D0180: Diagnostic (exams, radiographs)
- D0210: Full mouth radiographic series
- D1110-D1120: Preventive (cleanings, prophylaxis)
- D2140-D2394: Amalgam/composite restorations
- D2710-D2799: Crown procedures
- D2740: Crown - porcelain/ceramic
- D2750: Crown - porcelain fused to metal
- D3310-D3330: Endodontic treatment (root canals)
- D4210-D4341: Periodontic procedures
- D4341: Periodontal scaling and root planing
- D5110-D5899: Prosthodontics (dentures, partials)
- D6010-D6199: Implant services
- D7140-D7999: Oral and maxillofacial surgery
- D8010-D8999: Orthodontic treatment

DENIAL REASON APPEAL STRATEGIES:
- "Not medically necessary": Cite clinical findings, diagnosis codes, supporting radiographic evidence
- "Frequency limitation exceeded": Document accelerated disease progression, clinical exceptions
- "Waiting period not met": Reference continuous coverage documentation, emergency exceptions
- "Missing information": Proactively supply complete documentation in the letter body
- "Non-covered service": Argue medical necessity crossover or cite policy ambiguity
- "Downgraded/alternative procedure": Justify clinically why the performed procedure was required over the cheaper alternative
- "Pre-authorization not obtained": Reference emergency circumstances or document attempts to obtain authorization`;

export async function generateAppealLetter(
  claim: ClaimDetails,
  practice: PracticeProfile
): Promise<{ letter: string; model: string; promptUsed: string }>
{
  // SWITCHED TO HAIKU FOR FASTER GENERATION (2-3x faster than Sonnet)
  const model = 'claude-sonnet-4-6';
  
  // REDUCED TOKEN LIMIT FOR FASTER RESPONSE
  const maxTokens = 2048;  // Was 4096

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
    D0120: 'Periodic oral evaluation - established patient',
    D0140: 'Limited oral evaluation - problem focused',
    D0210: 'Intraoral - complete series of radiographic images',
    D0220: 'Intraoral - periapical first radiographic image',
    D0270: 'Bitewing - single radiographic image',
    D0330: 'Panoramic radiographic image',
    D1110: 'Prophylaxis - adult',
    D1120: 'Prophylaxis - child',
    D1206: 'Topical application of fluoride varnish',
    D1351: 'Sealant - per tooth',
    D2140: 'Amalgam - one surface, primary or permanent',
    D2150: 'Amalgam - two surfaces, primary or permanent',
    D2160: 'Amalgam - three surfaces, primary or permanent',
    D2330: 'Resin-based composite - one surface, anterior',
    D2331: 'Resin-based composite - two surfaces, anterior',
    D2332: 'Resin-based composite - three surfaces, anterior',
    D2391: 'Resin-based composite - one surface, posterior',
    D2392: 'Resin-based composite - two surfaces, posterior',
    D2393: 'Resin-based composite - three surfaces, posterior',
    D2394: 'Resin-based composite - four or more surfaces, posterior',
    D2740: 'Crown - porcelain/ceramic substrate',
    D2750: 'Crown - porcelain fused to high noble metal',
    D2751: 'Crown - porcelain fused to predominantly base metal',
    D3310: 'Endodontic therapy - anterior tooth',
    D3320: 'Endodontic therapy - bicuspid tooth',
    D3330: 'Endodontic therapy - molar tooth',
    D4341: 'Periodontal scaling and root planing - per quadrant',
    D4355: 'Full mouth debridement to enable comprehensive evaluation',
    D4910: 'Periodontal maintenance',
    D5110: 'Complete denture - maxillary',
    D5120: 'Complete denture - mandibular',
    D5211: 'Maxillary partial denture - resin base',
    D5212: 'Mandibular partial denture - resin base',
    D6010: 'Surgical placement of implant body',
    D6056: 'Prefabricated abutment',
    D7140: 'Extraction, erupted tooth',
    D7210: 'Surgical extraction of erupted tooth',
    D7240: 'Extraction of impacted tooth - partially bony',
    D9110: 'Palliative emergency treatment'
  };

  const procedureList = claim.procedureCodes.map(code => {
    const desc = procedureDescriptions[code] || 'Dental procedure';
    return `${code} — ${desc}`;
  }).join('\n  ');

  const amountClaimed = claim.amountClaimed ? `$${claim.amountClaimed.toFixed(2)}` : '[AMOUNT CLAIMED]';
  const amountDenied = claim.amountDenied ? `$${claim.amountDenied.toFixed(2)}` : '[AMOUNT DENIED]';

  // SHORTENED PROMPT FOR FASTER PROCESSING
  const userPrompt = `Generate a complete, professional dental insurance appeal letter ready to send.

PRACTICE INFORMATION:
Practice Name: ${practice.name}
${practiceAddress ? `Address: ${practiceAddress}` : 'Address: [PRACTICE ADDRESS]'}
${contactLine || '[PHONE NUMBER]'}
${practice.website ? `Website: ${practice.website}` : ''}
${practice.email ? `Email: ${practice.email}` : ''}
Provider: ${providerInfo}
${credentialsLine}

CLAIM INFORMATION:
Patient Name: ${claim.patientName}
Date of Birth: ${claim.patientDob}
Insurance Company: ${claim.insuranceCompany}
Policy Number: ${claim.policyNumber || '[POLICY NUMBER]'}
Claim Number: ${claim.claimNumber || '[CLAIM NUMBER]'}
Date of Service: ${claim.serviceDate}
Procedure Codes:
  ${procedureList}
Amount Claimed: ${amountClaimed}
Amount Denied: ${amountDenied}
Denial Reason: ${claim.denialReason}

LETTER REQUIREMENTS:
1. Use practice information for letterhead
2. Use today's date
3. Include subject line with claim number
4. Address the specific denial reason
5. Include signature block with provider name
6. Make it ready to send with minimal editing

Generate the complete letter now.`;

  const response = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      system: DENTAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      headers: { 
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
    }
  );

  const letter = response.content[0]?.type === 'text' ? response.content[0].text : '';

  return { letter, model, promptUsed: userPrompt };
}
