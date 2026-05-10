import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

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
6. Follow standard business letter format

Common CDT codes reference:
- D0120-D0180: Diagnostic (exams, radiographs)
- D0210: Full mouth radiographic series
- D1110-D1120: Preventive (cleanings, prophylaxis)
- D2140-D2394: Amalgam/composite restorations
- D2710-D2799: Crown procedures
- D3310-D3330: Endodontic treatment (root canals)
- D4210-D4341: Periodontic procedures
- D5110-D5899: Prosthodontics (dentures, partials)
- D6010-D6199: Implant services
- D7140-D7999: Oral and maxillofacial surgery
- D8010-D8999: Orthodontic treatment

Denial reason appeal strategies:
- "Not medically necessary": Cite clinical findings, diagnosis codes, supporting radiographic evidence
- "Frequency limitation exceeded": Document accelerated disease progression, clinical exceptions
- "Waiting period not met": Reference continuous coverage documentation, emergency exceptions
- "Missing information": Proactively supply complete documentation in the letter body
- "Non-covered service": Argue medical necessity crossover or cite policy ambiguity
- "Downgraded/alternative procedure": Justify clinically why the performed procedure was required over the cheaper alternative
- "Pre-authorization not obtained": Reference emergency circumstances or document attempts to obtain authorization`;

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

export async function generateAppealLetter(claim: ClaimDetails): Promise<{
  letter: string;
  model: string;
  promptUsed: string;
}> {
  const model = 'claude-sonnet-4-6';

  const userPrompt = `Generate a complete, professional dental insurance appeal letter using the following claim information. The letter should be ready to send with MINIMAL placeholder text.

CLAIM INFORMATION:
- Patient Name: ${claim.patientName}
- Date of Birth: ${claim.patientDob}
- Insurance Company: ${claim.insuranceCompany}
- Policy Number: ${claim.policyNumber || 'Not provided - USER MUST ADD'}
- Claim Number: ${claim.claimNumber || 'Not provided - USER MUST ADD'}
- Date of Service: ${claim.serviceDate}
- Procedure Codes: ${claim.procedureCodes.join(', ')}
- Amount Claimed: ${claim.amountClaimed != null ? `$${claim.amountClaimed.toFixed(2)}` : 'Not provided'}
- Amount Denied: ${claim.amountDenied != null ? `$${claim.amountDenied.toFixed(2)}` : 'Not provided'}
- Denial Reason: ${claim.denialReason}
- Submitting Practice: ${claim.practiceName}

CRITICAL RULES:
1. If Policy Number, Claim Number, Amounts are PROVIDED, use them directly in the letter.
2. If any field says "Not provided", insert a CLEAR placeholder like "[POLICY NUMBER FROM EOB]" so the user knows exactly what to fill.
3. Use the EXACT denial reason to tailor the clinical justification.
4. Include specific CDT code descriptions from the ADA guidelines.
5. Generate a complete letter with proper letterhead, date, recipient address, subject line, numbered sections, and signature block.
6. DO NOT add clinical findings that aren't in the claim data - use standard justifications for the procedure codes.

The letter should include:
- Practice header (ready for user to add address/phone)
- Date (current date)
- Insurance company appeals address placeholder
- Subject line with claim number and patient name
- A table of claim information
- Clinical justification section specific to the procedure codes
- Response to the specific denial reason
- Enclosures checklist
- Signature block with provider name placeholder
- Pre-send checklist for the user

Make the letter professional, persuasive, and as complete as possible. Use the denial reason to drive the clinical argument.`;

  const response = await client.messages.create(
    {
      model,
      max_tokens: 4096,
      system: DENTAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }
  );

  const letter = response.content[0]?.type === 'text' ? response.content[0].text : '';

  return { letter, model, promptUsed: userPrompt };
}
