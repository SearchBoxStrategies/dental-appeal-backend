// What to enclose with an appeal, based on the procedure codes and the denial reason.
// Rules-based on purpose: the list is the same every time for the same claim, costs nothing
// to produce and can be reviewed by a dental office manager line by line.

export interface ChecklistItem {
  id: string;
  label: string;
  why: string;
}

interface CodeRule {
  match: (code: string) => boolean;
  items: ChecklistItem[];
}

interface ReasonRule {
  match: RegExp;
  items: ChecklistItem[];
}

const inRange = (code: string, from: number, to: number) => {
  const n = parseInt(code.replace(/^D/i, ''), 10);
  return /^D\d{4}$/i.test(code) && n >= from && n <= to;
};

const ALWAYS: ChecklistItem[] = [
  { id: 'eob', label: 'Copy of the denial (EOB or denial letter)', why: 'Ties the appeal to the exact claim and denial code.' },
  { id: 'claim-form', label: 'Copy of the original claim form', why: 'Shows what was billed and when.' },
];

const CODE_RULES: CodeRule[] = [
  {
    match: (c) => inRange(c, 2700, 2799) || inRange(c, 6710, 6799),
    items: [
      { id: 'pa-preop', label: 'Pre-operative periapical x-ray of the tooth', why: 'Shows the decay, fracture or failing restoration.' },
      { id: 'photo-intraoral', label: 'Intraoral photo of the tooth before treatment', why: 'Fractures and cracks often do not show on x-rays.' },
      { id: 'crown-narrative', label: 'Narrative: % of tooth structure lost, fracture or decay, why a filling would fail', why: 'Insurers deny crowns as "restorable with a filling" without it.' },
      { id: 'prior-crown-date', label: 'Date of the prior crown on this tooth, if this is a replacement', why: 'Replacement limits are usually 5 to 7 years.' },
    ],
  },
  {
    match: (c) => inRange(c, 2140, 2399),
    items: [
      { id: 'bw-preop', label: 'Pre-operative bitewing or periapical x-ray', why: 'Shows the decay that was treated.' },
      { id: 'surfaces', label: 'Tooth number and surfaces treated', why: 'Mismatched surfaces are a common reason to deny or downgrade.' },
    ],
  },
  {
    match: (c) => inRange(c, 3300, 3399),
    items: [
      { id: 'pa-preop-endo', label: 'Pre-operative periapical x-ray', why: 'Shows the infection or pulp involvement.' },
      { id: 'pa-postop-endo', label: 'Post-operative periapical x-ray showing the fill', why: 'Proves the treatment was completed.' },
      { id: 'endo-diagnosis', label: 'Diagnosis and symptoms (pulp tests, pain, swelling)', why: 'Establishes that root canal therapy was necessary.' },
    ],
  },
  {
    match: (c) => inRange(c, 4341, 4342),
    items: [
      { id: 'perio-chart', label: 'Full periodontal charting with pocket depths (within the last 12 months)', why: 'Most plans require 4 mm+ pockets and charting to pay scaling and root planing.' },
      { id: 'xray-boneloss', label: 'Full-mouth x-rays or bitewings showing bone loss', why: 'Radiographic bone loss supports the periodontitis diagnosis.' },
      { id: 'perio-diagnosis', label: 'Periodontal diagnosis (stage and grade) and quadrants treated', why: 'Insurers check the quadrant count against the charting.' },
    ],
  },
  {
    match: (c) => c.toUpperCase() === 'D4355',
    items: [
      { id: 'debridement-narrative', label: 'Narrative: why a full evaluation was not possible before debridement', why: 'Full-mouth debridement is only covered when heavy deposits block an evaluation.' },
      { id: 'debridement-photo', label: 'Intraoral photos showing the calculus', why: 'Visual proof of the deposits.' },
    ],
  },
  {
    match: (c) => c.toUpperCase() === 'D4910',
    items: [
      { id: 'srp-history', label: 'Date of prior active periodontal therapy (SRP)', why: 'Periodontal maintenance is only covered after active therapy.' },
      { id: 'perio-chart-maint', label: 'Current periodontal charting', why: 'Shows ongoing need for maintenance instead of a regular cleaning.' },
    ],
  },
  {
    match: (c) => inRange(c, 5000, 5899),
    items: [
      { id: 'missing-teeth', label: 'Chart of missing teeth and dates of extraction', why: 'Needed for missing-tooth clause and replacement-limit reviews.' },
      { id: 'prior-prosthesis', label: 'Date and condition of any prior denture or partial', why: 'Replacement limits are usually 5 years.' },
      { id: 'pano-prosth', label: 'Panoramic x-ray', why: 'Shows the edentulous areas.' },
    ],
  },
  {
    match: (c) => inRange(c, 6000, 6199),
    items: [
      { id: 'pano-ct', label: 'Panoramic x-ray or CBCT of the implant site', why: 'Shows the site and bone available.' },
      { id: 'extraction-date', label: 'Date the tooth was extracted', why: 'Missing-tooth clauses deny teeth lost before coverage began.' },
      { id: 'implant-narrative', label: 'Narrative: why an implant rather than a bridge or partial', why: 'Insurers often pay only the "least costly alternative".' },
    ],
  },
  {
    match: (c) => inRange(c, 7200, 7299),
    items: [
      { id: 'pa-pano-ext', label: 'Pre-operative periapical or panoramic x-ray', why: 'Shows root shape, impaction or bone that required a surgical approach.' },
      { id: 'surgical-narrative', label: 'Narrative: why a surgical extraction (flap, bone removal, sectioning)', why: 'Surgical codes are downgraded to simple extractions without it.' },
    ],
  },
  {
    match: (c) => inRange(c, 100, 1999),
    items: [
      { id: 'service-history', label: 'Dates of the patient\'s prior exams, cleanings or x-rays', why: 'Frequency denials depend on the dates of earlier services.' },
    ],
  },
];

const REASON_RULES: ReasonRule[] = [
  {
    match: /frequen|limitation|once (every|per)|too soon|interval/i,
    items: [
      { id: 'frequency-history', label: 'Treatment history with dates for this procedure', why: 'Shows the frequency limit was met, or why an exception was needed.' },
      { id: 'frequency-narrative', label: 'Narrative of the change in condition that required earlier treatment', why: 'Insurers make exceptions for documented new disease or trauma.' },
    ],
  },
  {
    match: /necess|not (clinically )?indicated|not supported|insufficient (clinical|documentation)/i,
    items: [
      { id: 'necessity-narrative', label: 'Dentist\'s clinical narrative explaining medical necessity', why: 'The core of a medical-necessity appeal.' },
      { id: 'necessity-images', label: 'Diagnostic x-rays and photos supporting the diagnosis', why: 'Reviewers decide on the images.' },
    ],
  },
  {
    match: /missing tooth|prior to (coverage|effective)|pre-?existing/i,
    items: [
      { id: 'extraction-proof', label: 'Records showing when the tooth was lost', why: 'Proves the tooth was lost while covered, or the clause does not apply.' },
      { id: 'prior-coverage', label: 'Proof of prior continuous dental coverage', why: 'Many plans waive the clause with continuous coverage.' },
    ],
  },
  {
    match: /alternate|alternative|least costly|downgrad|LEAT/i,
    items: [
      { id: 'material-narrative', label: 'Narrative: why the alternate (cheaper) treatment would fail', why: 'Overturns "least expensive alternative treatment" reductions.' },
    ],
  },
  {
    match: /x-?ray|radiograph|image|documentation|information|records|narrative|chart/i,
    items: [
      { id: 'requested-records', label: 'The specific records the insurer asked for', why: 'Many denials are simply missing paperwork.' },
    ],
  },
  {
    match: /timely|filing limit|late/i,
    items: [
      { id: 'timely-proof', label: 'Clearinghouse report or proof of the original submission date', why: 'Shows the claim was filed on time.' },
    ],
  },
  {
    match: /coordination|COB|other (insurance|coverage)|primary/i,
    items: [
      { id: 'primary-eob', label: 'Primary insurer\'s EOB', why: 'Required for the secondary insurer to pay.' },
      { id: 'cob-form', label: 'Patient\'s completed coordination of benefits form', why: 'Confirms which plan is primary.' },
    ],
  },
  {
    match: /eligib|not covered on|terminat|inactive/i,
    items: [
      { id: 'eligibility-proof', label: 'Eligibility verification from the date of service', why: 'Shows the patient was covered when treated.' },
    ],
  },
  {
    match: /duplicate/i,
    items: [
      { id: 'duplicate-explain', label: 'Explanation of how this service differs from the earlier claim (tooth, surface, date)', why: 'Clarifies it is not a resubmission of the same service.' },
    ],
  },
  {
    match: /pre-?(auth|determination|treatment estimate)/i,
    items: [
      { id: 'preauth', label: 'Pre-authorization or predetermination approval, or reason treatment could not wait', why: 'Emergency treatment is often exempt.' },
    ],
  },
];

export function buildChecklist(procedureCodes: string[], denialReason: string): ChecklistItem[] {
  const items = new Map<string, ChecklistItem>();
  const add = (list: ChecklistItem[]) => list.forEach((item) => { if (!items.has(item.id)) items.set(item.id, item); });

  add(ALWAYS);
  for (const code of procedureCodes || []) {
    for (const rule of CODE_RULES) if (rule.match(code)) add(rule.items);
  }
  for (const rule of REASON_RULES) if (rule.match.test(denialReason || '')) add(rule.items);

  // Every appeal is stronger with a signed clinical narrative.
  add([{ id: 'dentist-note', label: 'Signed clinical narrative from the treating dentist', why: 'The evidence reviewers weigh most.' }]);
  return [...items.values()];
}
