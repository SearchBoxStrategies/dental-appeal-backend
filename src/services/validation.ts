import { db } from '../db';

export interface ValidationResult {
  passed: boolean;
  warnings: string[];
  errors: string[];
  autoFixed: boolean;
  details?: any[];
}

export const validateClaim = async (claimData: any, claimId?: number): Promise<ValidationResult> => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const details: any[] = [];
  
  // Fetch claim from database if only ID provided
  let claim = claimData;
  if (claimId && !claimData.id) {
    const { rows: [fetchedClaim] } = await db.query(
      'SELECT * FROM claims WHERE id = $1',
      [claimId]
    );
    claim = fetchedClaim;
  }
  
  // 1. Check for missing documentation
  if (claimId) {
    const { rows: documents } = await db.query(
      'SELECT COUNT(*) FROM claim_documents WHERE claim_id = $1',
      [claimId]
    );
    
    if (parseInt(documents[0].count) === 0) {
      warnings.push('No supporting documents attached. X-rays or clinical notes strengthen appeal success.');
      details.push({ type: 'documentation', message: 'Missing attachments', severity: 'warning' });
    }
  }
  
  // 2. Validate procedure codes are valid
  const validCodes = ['D0120', 'D0140', 'D0210', 'D0220', 'D0270', 'D0330', 
    'D1110', 'D1120', 'D1206', 'D1351', 'D2140', 'D2150', 'D2160', 'D2330', 
    'D2331', 'D2332', 'D2391', 'D2392', 'D2393', 'D2394', 'D2740', 'D2750', 
    'D2751', 'D3310', 'D3320', 'D3330', 'D4341', 'D4355', 'D4910', 'D5110',
    'D5120', 'D5211', 'D5212', 'D6010', 'D6056', 'D7140', 'D7210', 'D7240', 'D9110'];
    
  const procedureCodes = claim.procedure_codes || claimData.procedure_codes || [];
  for (const code of procedureCodes) {
    if (!validCodes.includes(code)) {
      errors.push(`Procedure code ${code} may not be valid. Verify with insurance provider.`);
      details.push({ type: 'coding', code, message: 'Invalid procedure code', severity: 'error' });
    }
  }
  
  // 3. Check for missing procedure codes
  if (procedureCodes.length === 0) {
    errors.push('At least one procedure code is required.');
    details.push({ type: 'data', message: 'No procedure code selected', severity: 'error' });
  }
  
  // 4. Check for denial reason completeness
  const denialReason = claim.denial_reason || claimData.denial_reason;
  if (!denialReason || denialReason.length < 10) {
    warnings.push('Denial reason is brief. Adding more detail improves appeal success rates.');
    details.push({ type: 'documentation', message: 'Brief denial reason', severity: 'warning' });
  }
  
  // 5. Check for missing patient information
  const patientDob = claim.patient_dob || claimData.patient_dob;
  if (!patientDob) {
    errors.push('Patient date of birth is required for claim validation.');
    details.push({ type: 'data', message: 'Missing patient DOB', severity: 'error' });
  }
  
  // 6. Check service date validity
  const serviceDate = claim.service_date || claimData.service_date;
  if (serviceDate) {
    const serviceDateObj = new Date(serviceDate);
    const today = new Date();
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(today.getFullYear() - 2);
    
    if (serviceDateObj > today) {
      errors.push('Service date cannot be in the future.');
      details.push({ type: 'data', message: 'Future service date', severity: 'error' });
    }
    if (serviceDateObj < twoYearsAgo) {
      warnings.push('Service date is over 2 years old. Check timely filing limits.');
      details.push({ type: 'data', message: 'Old service date', severity: 'warning' });
    }
  }
  
  // 7. Check for missing policy number
  const policyNumber = claim.policy_number || claimData.policy_number;
  if (!policyNumber) {
    warnings.push('Policy number is missing. Insurance may require this for processing.');
    details.push({ type: 'data', message: 'Missing policy number', severity: 'warning' });
  }
  
  // 8. Check for missing claim number
  const claimNumber = claim.claim_number || claimData.claim_number;
  if (!claimNumber) {
    warnings.push('Claim number is missing. This is required for the appeal letter.');
    details.push({ type: 'data', message: 'Missing claim number', severity: 'warning' });
  }
  
  // 9. Check for amount validity
  const amountDenied = claim.amount_denied || claimData.amount_denied;
  if (amountDenied && amountDenied <= 0) {
    warnings.push('Amount denied is zero or negative. Verify this is correct.');
    details.push({ type: 'data', message: 'Invalid denied amount', severity: 'warning' });
  }
  
  // Store validation results in database if claimId provided
  if (claimId) {
    // Clear existing validations for this claim
    await db.query('DELETE FROM claim_validations WHERE claim_id = $1', [claimId]);
    
    // Store errors
    for (const error of errors) {
      await db.query(
        `INSERT INTO claim_validations (claim_id, issue_found, issue_message, requires_attention, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [claimId, true, error, true]
      );
    }
    
    // Store warnings
    for (const warning of warnings) {
      await db.query(
        `INSERT INTO claim_validations (claim_id, issue_found, issue_message, requires_attention, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [claimId, true, warning, false]
      );
    }
  }
  
  return {
    passed: errors.length === 0,
    warnings,
    errors,
    autoFixed: false,
    details
  };
};

export const getValidationSummary = async (claimId: number) => {
  const { rows } = await db.query(`
    SELECT 
      COUNT(*) as total_checks,
      COUNT(CASE WHEN issue_found THEN 1 END) as issues_found,
      COUNT(CASE WHEN requires_attention THEN 1 END) as needs_attention
    FROM claim_validations 
    WHERE claim_id = $1
  `, [claimId]);
  
  return rows[0] || { total_checks: 0, issues_found: 0, needs_attention: 0 };
};

export const getValidationDetails = async (claimId: number) => {
  const { rows } = await db.query(`
    SELECT id, issue_message, requires_attention, created_at
    FROM claim_validations 
    WHERE claim_id = $1
    ORDER BY requires_attention DESC, created_at ASC
  `, [claimId]);
  
  return rows;
};
