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

  const userPrompt = `Generate a complete insurance appeal letter for the following denied dental claim:

Patient Name: ${claim.patientName}
Date of Birth: ${claim.patientDob}
Insurance Company: ${claim.insuranceCompany}
Policy Number: ${claim.policyNumber ?? 'N/A'}
Claim Number: ${claim.claimNumber ?? 'N/A'}
Date of Service: ${claim.serviceDate}
Procedure Codes: ${claim.procedureCodes.join(', ')}
Amount Claimed: ${claim.amountClaimed != null ? `$${claim.amountClaimed.toFixed(2)}` : 'N/A'}
Amount Denied: ${claim.amountDenied != null ? `$${claim.amountDenied.toFixed(2)}` : 'N/A'}
Denial Reason: ${claim.denialReason}
Submitting Practice: ${claim.practiceName}

Generate the complete letter, ready to print and send. Include:
- Today's date
- [PRACTICE ADDRESS] and [INSURANCE COMPANY ADDRESS] placeholders
- Proper salutation, body paragraphs with clinical justification, and closing
- Signature block with practice name`;

  const response = await client.messages.create(
    {
      model,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: DENTAL_SYSTEM_PROMPT,
          // @ts-ignore -- prompt caching beta field
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
    } as Parameters<typeof client.messages.create>[1]
  );

  const letter =
    response.content[0]?.type === 'text' ? response.content[0].text : '';

  return { letter, model, promptUsed: userPrompt };
}
