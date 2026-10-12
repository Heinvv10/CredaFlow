/**
 * VLM Extraction Service
 *
 * Calls VLM (configured via VLM_MODEL env var) for document OCR extraction.
 * Includes SA-context-aware prompts, field mapping, and ID validation post-processing.
 */

import { TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES } from '@/lib/compliance/debit-mandate'
import {
  crossValidateSaIdWithDob,
  isValidSaIdChecksum,
} from '@/lib/ocr/saIdValidationService'

/**
 * Standard shape for a single extracted field.
 *
 * There is deliberately NO confidence here. The VLM returns no per-field
 * confidence, so any number in this position would be invented — and it was:
 * every field of every document type used to carry a hardcoded 0.95 that the
 * staff UI rendered as "(95%)", next to values the model had merely guessed.
 * Do not reintroduce one unless the model actually reports it per field.
 *
 * `validated` is NOT a confidence and NOT a claim that anything checked the
 * value against a source. It means "no post-processing rule flagged this as
 * inconsistent" — the SA-ID Luhn/length checks and the payslip totals
 * reconciliation set it false. It is load-bearing: apply-extraction refuses to
 * write a field with `validated === false` (app/api/clients/[id]/apply-extraction).
 */
export interface ExtractedField {
  value: unknown
  validated: boolean
}

export type ExtractedFields = Record<string, ExtractedField>

type VlmConfig = { url: string; model: string }

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true
  return value.includes('replace-with-') || value.includes('example.com')
}

function getVlmConfig(): VlmConfig | null {
  const apiUrl = process.env.VLM_API_URL
  const model = process.env.VLM_MODEL
  if (isPlaceholder(apiUrl) || isPlaceholder(model)) return null
  return { url: `${apiUrl!.replace(/\/$/, '')}/v1/chat/completions`, model: model! }
}

/** SA-context-aware VLM prompts per document type */
const VLM_PROMPTS: Record<string, string> = {
  ID_COPY: `Extract all fields from this South African ID document (Smart ID card or green ID book). Return JSON with:
- idNumber: The SA ID number - MUST be EXACTLY 13 digits. Count carefully: YYMMDD SSSS C A Z format.
- surname: Surname/Last name
- firstName: First names
- dateOfBirth: Date of birth (YYYY-MM-DD format) - first 6 digits of ID = YYMMDD
- gender: Gender (Male/Female)
CRITICAL: SA ID numbers are always exactly 13 digits. Common OCR errors: O→0, I→1, S→5, B→8. These are ALL digits.
Return ONLY valid JSON, no other text.`,

  PAYSLIP: `Extract all fields from this South African payslip. Return JSON with:
- employerName: Company/employer name
- employeeIdNumber: Employee ID number if visible (13-digit SA ID)
- employeeName: Full name of employee
- grossIncome: THIS MONTH's total earnings before deductions, in cents (integer, e.g. 1500000 for R15,000.00)
- netIncome: THIS MONTH's net/take-home pay, in cents (integer)
- payPeriod: Pay period (YYYY-MM format, e.g. "2026-03")
- payDate: Date of payment (YYYY-MM-DD)
- totalDeductions: THIS MONTH's total deductions, in cents (integer)
- incomeColumnHeading: The EXACT column heading, copied verbatim, that you read grossIncome/netIncome/totalDeductions from (e.g. "Current", "This Period", "Amount", "YTD Amount", "Jaar tot datum"). Copy the printed heading exactly as it appears — do NOT translate it, abbreviate it, tidy it, or substitute a heading you think it means. Reporting "Current" for a column actually headed something else defeats the purpose of this field. If the payslip has only one amount column and no heading above it, return "".
CRITICAL — CURRENT PERIOD ONLY: SA payslips print each amount twice, side by
side. The left column is this single month ("Current", "This Period", "Amount",
"Month"); a further-right column is the cumulative total for the tax year
("YTD", "YTD Amount", "Year to Date", "Cumulative"). ALWAYS read the current-period
column. NEVER return a YTD figure — it is roughly the monthly amount multiplied by
the number of months worked this tax year, and using it overstates the person's
income several times over. Read "Total Earnings" and "Total Deductions" from that
same current-period column, and "Net Pay" from the row that usually has no YTD value.
CHECK BEFORE ANSWERING: grossIncome minus totalDeductions MUST equal netIncome. If it
does not, you have mixed columns — re-read all three from the current-period column.
CRITICAL: Return monetary values as integers in cents (multiply Rands by 100). If you see "R 15 000.00" return 1500000.
Return ONLY valid JSON, no other text.`,

  BANK_STATEMENT: `Extract key fields from this South African bank statement or bank confirmation letter. Return JSON with:
- bankName: Name of the bank (ABSA, FNB, Standard Bank, Nedbank, Capitec, etc.)
- accountHolder: Account holder full name
- accountNumber: Bank account number (ALL digits, 10-13 digits)
- branchCode: Branch code ONLY if the page actually prints one (6 digits), otherwise null. Most South African banks use a single universal branch code and do not print it on statements — do NOT infer, recall or calculate it, and do NOT copy digits from the account number. A null here is correct and expected; the branch code is derived from the bank instead.
- accountType: One of exactly CHEQUE, SAVINGS or OTHER. Statements print the bank's PRODUCT name, not the account type: map a transactional/current/cheque product to CHEQUE ("Transaction Account", "Easy Account", "Gold Cheque Account", "PRESTIGEACC"), and a savings product to SAVINGS. Use OTHER when the product is genuinely neither or you cannot tell — do NOT guess between CHEQUE and SAVINGS.
- accountTypePrinted: The account type EXACTLY as printed on the statement, verbatim, for the audit trail (e.g. "Transaction Account"). Null if the page does not state one.
- statementDate: Statement date (YYYY-MM-DD) if visible
Common OCR confusions: 0↔O, 1↔I, 6↔G, 8↔B — account number is ALL digits.
Return ONLY valid JSON, no other text.`,

  PROOF_OF_ADDRESS: `Analyse this document and extract the residential address. A valid proof of address must show a physical residential address for a named person — this can be a utility bill, municipal account, bank letter, lease agreement, or any official document that includes a full street address. Return JSON with:
- hasResidentialAddress: true if the document contains a clear physical street address for a named person, false if no address is present or it only shows a PO Box
- addressLine1: Street number and name (e.g. "12 Oak Street")
- suburb: Suburb or area
- city: City or town
- province: Province
- postalCode: Postal code (4 digits)
- issuerName: Name of issuing company, bank, or municipality
- issueDate: Document date (YYYY-MM-DD)
- accountHolder: Full name of person the document is addressed to
- documentCategory: What type of document this is (e.g. "utility_bill", "bank_letter", "municipal_account", "lease", "bank_statement", "other")
CRITICAL: Focus on finding the RESIDENTIAL ADDRESS. Even a bank statement is valid if it shows a full street address for the account holder.
Return ONLY valid JSON, no other text.`,

  SELFIE: `Analyse this selfie/portrait photo for KYC liveness verification. Return JSON with:
- faceDetected: true if a human face is clearly visible, false otherwise
- facesCount: number of faces detected (should be exactly 1)
- quality: "good" | "poor" | "unusable"
- isLive: true if this appears to be a live person photographed directly, false if it looks like a photo of a photo, screenshot, or printed image
- livenessIndicators: array of strings describing what you observe (e.g. "natural skin texture", "screen reflection visible", "natural lighting", "paper edges visible")
- frontFacing: true if face is front-facing (not profile)
- eyesOpen: true if eyes are clearly open
- qualityIssues: array of any issues found (e.g. "too dark", "blurry", "partial face", "sunglasses", "mask")
CRITICAL: Return ONLY valid JSON, no other text.`,

  // Two-image variant: Image 1 is the live selfie, Image 2 the client's ID
  // document. The VLM is the biometric provider — the match verdict and both
  // confidences below become the persisted matchScore/livenessScore evidence,
  // so wording changes here change what the KYC gate measures.
  SELFIE_FACE_MATCH: `Image 1 is a selfie submitted for KYC identity verification. Image 2 is meant to be a South African identity document (Smart ID card or green ID book) carrying a printed photograph of its holder. Judge Image 2's portrait area on its own FIRST, before comparing anything. Return JSON with these keys, in this order:
- idPhotoKind: exactly one of "photograph" | "silhouette_placeholder" | "illustration" | "blank_or_missing" | "obscured" | "other" — what occupies the portrait area of Image 2. "photograph" ONLY for a camera photograph of a real human being (natural skin texture, real lighting and shading, real hair). A grey or flat-coloured head-and-shoulders shape or avatar icon is "silhouette_placeholder". A drawing, cartoon, clip-art, emoji or computer-rendered face is "illustration". An empty, plain or missing portrait area is "blank_or_missing". A photo that is covered, scratched out or too damaged to see the face is "obscured".
- idPhotoIsRealPhotograph: true ONLY if idPhotoKind is "photograph"
- idPhotoFaceDetected: true ONLY if a real photographed human face is clearly visible in Image 2's portrait area. A silhouette, outline or drawn face is NOT a face.
- faceDetected: true if a human face is clearly visible in Image 1, false otherwise
- facesCount: number of faces detected in Image 1 (should be exactly 1)
- quality: "good" | "poor" | "unusable" — the selfie's quality
- selfieIsRealPhotograph: true ONLY if Image 1 is a camera photograph of a real human being (not a drawing, cartoon, rendering, mask or mannequin)
- isLive: true if Image 1 appears to be a live person photographed directly, false if it looks like a photo of a photo, screenshot, or printed image
- livenessConfidence: number between 0 and 1 — how confident you are in the isLive judgement
- livenessIndicators: array of strings describing what you observe (e.g. "natural skin texture", "screen reflection visible", "natural lighting", "paper edges visible")
- frontFacing: true if the face in Image 1 is front-facing (not profile)
- eyesOpen: true if eyes are clearly open in Image 1
- qualityIssues: array of any issues found in Image 1 (e.g. "too dark", "blurry", "partial face", "sunglasses", "mask")
- samePerson: exactly one of "same" | "different" | "uncertain" — whether Image 1 and the photograph in Image 2 show the same person. ID photos can be years old — allow for ageing, hairstyle, glasses and facial-hair changes, but the underlying facial structure (face shape, eyes, nose, mouth, ears) must match.
- faceMatch: true ONLY if samePerson is "same"
- matchConfidence: number between 0 and 1 — how confident you are that Image 1 and the photograph in Image 2 show the same real person. Use low values when either face is unclear.
Do not transcribe any text from Image 2.
CRITICAL: Return ONLY valid JSON, no other text.`,

  OTHER: `Extract all visible text and data from this document. Return JSON with:
- documentType: What type of document this appears to be
- extractedText: Key text content
- fields: An object with any identifiable fields and their values
Return ONLY valid JSON, no other text.`,
}

/** Maps VLM response field names to standardised field names per doc type */
const FIELD_MAPPINGS: Record<string, Record<string, string>> = {
  ID_COPY: {
    idNumber: 'documentNumber',
    surname: 'surname',
    firstName: 'firstName',
    dateOfBirth: 'dateOfBirth',
    gender: 'gender',
  },
  PAYSLIP: {
    employerName: 'employerName',
    employeeIdNumber: 'employeeIdNumber',
    employeeName: 'employeeName',
    grossIncome: 'grossIncome',
    netIncome: 'netIncome',
    payPeriod: 'payPeriod',
    payDate: 'payDate',
    totalDeductions: 'totalDeductions',
  },
  BANK_STATEMENT: {
    bankName: 'bankName',
    accountHolder: 'accountHolder',
    accountNumber: 'accountNumber',
    branchCode: 'branchCode',
    accountType: 'accountType',
    accountTypePrinted: 'accountTypePrinted',
    statementDate: 'statementDate',
  },
  PROOF_OF_ADDRESS: {
    addressLine1: 'addressLine1',
    suburb: 'suburb',
    city: 'city',
    province: 'province',
    postalCode: 'postalCode',
    issuerName: 'issuerName',
    issueDate: 'issueDate',
    accountHolder: 'accountHolder',
  },
  SELFIE: {
    faceDetected: 'faceDetected',
    facesCount: 'facesCount',
    quality: 'quality',
    isLive: 'isLive',
    livenessConfidence: 'livenessConfidence',
    livenessIndicators: 'livenessIndicators',
    frontFacing: 'frontFacing',
    eyesOpen: 'eyesOpen',
    qualityIssues: 'qualityIssues',
    idPhotoFaceDetected: 'idPhotoFaceDetected',
    idPhotoKind: 'idPhotoKind',
    idPhotoIsRealPhotograph: 'idPhotoIsRealPhotograph',
    selfieIsRealPhotograph: 'selfieIsRealPhotograph',
    samePerson: 'samePerson',
    faceMatch: 'faceMatch',
    matchConfidence: 'matchConfidence',
  },
}

/**
 * Parse raw VLM response into a plain key/value object.
 */
function parseVlmResponse(rawContent: string): Record<string, unknown> {
  try {
    // Strip markdown code fences if present
    const cleaned = rawContent
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>
    }
  } catch {
    // Fall through
  }
  return {}
}

/**
 * Map raw VLM-extracted key/value pairs to normalised ExtractedFields.
 */
function mapExtractedFields(
  extractedData: Record<string, unknown>,
  docType: string
): ExtractedFields {
  const fieldMapping = FIELD_MAPPINGS[docType] ?? {}
  const extractedFields: ExtractedFields = {}

  for (const [vlmField, value] of Object.entries(extractedData)) {
    if (value !== null && value !== undefined && value !== '') {
      const mappedField = fieldMapping[vlmField] ?? vlmField
      extractedFields[mappedField] = {
        value,
        validated: true,
      }
    }
  }

  return extractedFields
}

/** Exposed for tests: the prompt that must pin the VLM to the current-period column. */
export function payslipPrompt(): string {
  return VLM_PROMPTS.PAYSLIP
}

/** Rounding slack between the three payslip totals, in cents. */
const PAYSLIP_TOTALS_TOLERANCE_CENTS = 100

/**
 * The payslip figures that feed affordability. DocumentsTab renders these as
 * rands rather than raw cents — keep the two lists together if either changes.
 */
export const PAYSLIP_MONEY_FIELDS = ['grossIncome', 'totalDeductions', 'netIncome'] as const

/**
 * Column headings that mean "this pay period" on an SA payslip, English and
 * Afrikaans. Matched after stripping punctuation, so "Current", "current-period"
 * and "Current Period" all land on the same rule.
 *
 * This is an ALLOW-list on purpose. Deny-listing year-to-date wordings only
 * catches the ones someone thought to write down: "Jaar tot datum", "Cum.",
 * "Y/E" and "Tax Year Total" all escaped an earlier ytd/cumulative deny-list
 * while reconciling arithmetically, because gross - deductions = net holds for
 * cumulative totals too. An unrecognised heading is an unverified one, and this
 * figure decides whether someone is lent money.
 */
const CURRENT_PERIOD_HEADINGS = [
  'current', 'currentperiod', 'thisperiod', 'period', 'thismonth', 'month',
  'amount', 'huidige', 'huidigetydperk', 'hierdietydperk', 'bedrag', 'maand',
]

function isCurrentPeriodHeading(heading: string): boolean {
  const flat = heading.toLowerCase().replace(/[^a-z]/g, '')
  return CURRENT_PERIOD_HEADINGS.includes(flat)
}

function centsField(fields: ExtractedFields, key: string): number | null {
  const raw = fields[key]?.value
  // Only a number is trusted. The prompt asks for integer cents, but nothing
  // makes the model comply, and Number("40123.45") or Number(" 4012345 ")
  // would silently coerce a rand figure or a padded string into a cents value.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw
}

/**
 * Cross-check the three payslip totals against each other.
 *
 * SA payslips print a current-period column beside a year-to-date column, and
 * the VLM has read Total Earnings / Total Deductions from the YTD side while
 * reading Net Pay — which carries no YTD figure — from the current side. That
 * produces a gross several times the client's real monthly income, which is
 * exactly the number affordability is decided on. The prompt asks for the
 * current column; this checks it, because a prompt is not a control.
 *
 * gross - deductions must equal net. Mixed columns break that identity; a
 * clean read satisfies it. Fields are flagged, never silently rewritten — we
 * cannot know which of the three was misread.
 *
 * Mutates extractedFields in-place.
 */
export function applyPayslipPostProcessing(
  extractedFields: ExtractedFields,
  docType: string
): ExtractedFields {
  if (docType !== 'PAYSLIP') return extractedFields

  const gross = centsField(extractedFields, 'grossIncome')
  const deductions = centsField(extractedFields, 'totalDeductions')
  const net = centsField(extractedFields, 'netIncome')

  // Provenance beats arithmetic. A read taken wholly from the YTD column
  // satisfies gross - deductions = net exactly — the identity holds for every
  // month, so it holds for the running sums too — and is still several months
  // of income. Only the column heading distinguishes them.
  const heading = extractedFields.incomeColumnHeading?.value
  const headingText = typeof heading === 'string' ? heading : ''

  const distrust = (reason: string) => {
    for (const key of PAYSLIP_MONEY_FIELDS) {
      if (extractedFields[key]) extractedFields[key].validated = false
    }
    extractedFields._payslipConsistencyWarning = { value: reason, validated: false }
    return extractedFields
  }

  // Fail closed on anything the identity cannot be run over. Returning early
  // here would leave the fields at mapExtractedFields' default validated:true,
  // which is an assertion the code has not earned: a VLM answering with
  // "R26,543.21" for net and YTD integers for the other two would be vouched
  // for and applied. An unrunnable check must distrust, not abstain.
  if (gross === null || deductions === null || net === null) {
    const unreadable = (['grossIncome', 'totalDeductions', 'netIncome'] as const)
      .filter((k) => centsField(extractedFields, k) === null)
    return distrust(
      `Payslip totals could not be checked: ${unreadable.join(', ')} ` +
      `${unreadable.length === 1 ? 'was' : 'were'} missing or could not be read as a number. ` +
      `Capture the income by hand against the payslip.`,
    )
  }

  // An absent or blank heading is not evidence of contamination: a single-column
  // payslip has none to report, and an extraction predating this field carries
  // none either. Those fall through to the arithmetic check below.
  if (headingText.trim() !== '' && !isCurrentPeriodHeading(headingText)) {
    return distrust(
      `Payslip figures were read from the "${headingText}" column, which is not a ` +
      `recognised current-period heading. A year-to-date column is the monthly ` +
      `amount multiplied by the months worked this tax year, and reconciles ` +
      `arithmetically, so it cannot be ruled out from the figures alone. Capture ` +
      `this month's figures by hand against the payslip.`,
    )
  }

  const drift = Math.abs(gross - deductions - net)
  if (drift > PAYSLIP_TOTALS_TOLERANCE_CENTS) {
    return distrust(
      `Payslip totals do not reconcile: gross R${(gross / 100).toFixed(2)} ` +
      `- deductions R${(deductions / 100).toFixed(2)} = R${((gross - deductions) / 100).toFixed(2)}, ` +
      `but net pay reads R${(net / 100).toFixed(2)}. A year-to-date (YTD) column may have been ` +
      `read instead of the current month. Verify against the payslip before applying to the client.`,
    )
  }

  return extractedFields
}

/**
 * SAVINGS bank PRODUCT names, as printed on real statements. The model is
 * asked to map the printed product to CHEQUE/SAVINGS itself and to answer
 * OTHER when unsure, but it guesses: an ABSA "Flexi Account" can come back CHEQUE
 * and a correct SAVINGS payout record is then refused as a mismatch.
 * ABSA sells the product as the "Flexi Savings Account" (absa.co.za, personal
 * banking > save & invest); statements print it as "Flexi Account".
 *
 * The CHEQUE side reuses `TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES` from the
 * disbursement gate, so the two never disagree about a transactional product.
 * The gate has no savings list because a savings statement that the model
 * labels SAVINGS already canonicalises; this list only exists to correct the
 * model's guess. Keys are compacted (letters only, lower-case) and matched by
 * PREFIX, so each must name one product, never a brand. Add a name only
 * against a real statement.
 */
export const SAVINGS_ACCOUNT_PRODUCT_PREFIXES = [
  'flexiaccount',   // ABSA Flexi (Savings) Account, printed "Flexi Account"
  'flexisavings',   // ABSA Flexi Savings Account
  'mymo',           // Standard Bank MyMo, printed "MYMOACC"; savings
] as const

function printedProductAccountType(printed: string): 'CHEQUE' | 'SAVINGS' | null {
  const compact = printed.replace(/[^A-Za-z]/g, '').toLowerCase()
  if (TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES.some((p) => compact.startsWith(p))) return 'CHEQUE'
  if (SAVINGS_ACCOUNT_PRODUCT_PREFIXES.some((p) => compact.startsWith(p))) return 'SAVINGS'
  return null
}

/**
 * Apply bank-statement post-processing: a recognised printed product name
 * overrides the model's accountType. Mutates extractedFields in-place.
 */
export function applyBankProductPostProcessing(
  extractedFields: ExtractedFields,
  docType: string
): ExtractedFields {
  if (docType !== 'BANK_STATEMENT') return extractedFields
  const printed = extractedFields.accountTypePrinted?.value
  if (typeof printed !== 'string') return extractedFields
  const type = printedProductAccountType(printed)
  if (!type) return extractedFields
  extractedFields.accountType = { value: type, validated: true }
  return extractedFields
}

/**
 * Apply SA-ID-specific post-processing: Luhn check + DOB cross-validation.
 * Mutates extractedFields in-place.
 */
export function applyIdValidationPostProcessing(
  extractedFields: ExtractedFields,
  docType: string
): ExtractedFields {
  if (docType !== 'ID_COPY' || !extractedFields.documentNumber) {
    return extractedFields
  }

  const idValue = String(extractedFields.documentNumber.value ?? '').replace(/[\s\-]/g, '')

  // Length check
  if (idValue.length !== 13) {
    extractedFields._idLengthWarning = {
      value: `Extracted ID "${idValue}" has ${idValue.length} digits instead of 13. Please verify manually.`,
      validated: false,
    }
    extractedFields.documentNumber.validated = false
    return extractedFields
  }

  // Luhn checksum
  if (!isValidSaIdChecksum(idValue)) {
    extractedFields._idValidationWarning = {
      value: `SA ID "${idValue}" fails Luhn checksum validation. The number may contain OCR errors.`,
      validated: false,
    }
    extractedFields.documentNumber.validated = false
  }

  // DOB cross-validation
  if (!extractedFields.dateOfBirth) {
    return extractedFields
  }

  const crossValidation = crossValidateSaIdWithDob(
    String(extractedFields.documentNumber.value),
    String(extractedFields.dateOfBirth.value)
  )

  if (crossValidation.corrected) {
    extractedFields.documentNumber = {
      value: crossValidation.correctedId,
      validated: true,
    }
    extractedFields._idCorrectionNote = {
      value: crossValidation.reason,
      validated: true,
    }
  } else if (crossValidation.mismatch) {
    extractedFields._idValidationWarning = {
      value: crossValidation.reason,
      validated: false,
    }
  }

  return extractedFields
}

// VLM only accepts images — convert a PDF's first page to JPEG using pdftoppm.
/**
 * Create a scratch directory only this process can enter, and hand its path to
 * `work`. Removed recursively afterwards, success or failure.
 *
 * Everything written inside is the client's document in the clear — income, ID
 * number, employer, bank account. `writeFileSync` defaults to 0664 (0644 under
 * Docker's umask), and `pdftoppm` creates its output JPEG with the same
 * exposure, which no file mode of ours can fix because we do not create it. A
 * 0700 directory closes both: without execute permission on the directory, no
 * other user can reach any file inside it whatever its own mode. POPIA — this
 * is special personal information sitting on a shared filesystem.
 */
async function withPrivateTempDir<T>(work: (dir: string) => Promise<T> | T): Promise<T> {
  const { mkdtempSync, rmSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')
  const dir = mkdtempSync(join(tmpdir(), 'vlm-'))
  try {
    return await work(dir)
  } finally {
    // A failure is exactly when the plaintext must still go: cleanup on the
    // success path only would leave client documents in /tmp.
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}

/**
 * Address-space ceiling for the PDF tools, in KB.
 *
 * poppler must inflate a compressed stream to render it, so a small upload
 * whose streams expand to gigabytes drives the rendering process to gigabytes
 * too. Measured against the real binaries: a 1.94MB PDF whose single Flate
 * stream expands to 2GB drove the tooling to 13.7GB RSS. It clears every check
 * this code has — valid PDF magic, far under the 10MB upload cap — and the
 * upload route has no rate limit, so it is an OOM primitive against the
 * container serving staff, disbursement and every tenant.
 *
 * The number was set by testing BOTH directions, because a ceiling that breaks
 * real client documents is worse than the attack it prevents. The bomb is held
 * to 21MB here against 13.7GB unbounded.
 *
 * A genuine A4 3-page 600dpi colour scan renders at 256MB, and at every size
 * above it, so 1GB is not a tight bound for real scans. It is kept because it
 * costs nothing and holds the bomb. Beware test fixtures built by ImageMagick:
 * it writes the PIXEL COUNT as the page size, so a 4960x7016 pixel scan declares
 * a 4960x7016 POINT page, ~70x the area of A4, and measures page geometry rather
 * than scan resolution.
 *
 * What happens to a bounded bomb varies by how it is built, and NOT every case
 * fails loudly. A stream inflating inside the page content dies and is caught.
 * An oversized IMAGE stream can instead have poppler swallow the failed
 * allocation and exit 0, leaving a small degraded JPEG — so a bounded document
 * may still hand the model a blank or corrupt page rather than an error.
 *
 * Closed by isFullPageRender: the output is now checked against the
 * size that was asked for, and a stub fails the extraction instead of being
 * sent. Measured once it could be provoked deliberately: 631 bytes, 1x1 px,
 * exit 0.
 *
 * The reasoning this paragraph used to carry — that such figures cannot satisfy
 * applyPayslipPostProcessing's reconciliation, so it was a data-quality gap and
 * not a security one — was too comfortable twice over. Reconciliation covers
 * PAYSLIP only; BANK_STATEMENT, ID_DOCUMENT and proof of address run the same
 * render with no arithmetic identity to fail. And a model shown a blank page
 * can return internally consistent invented figures, which reconcile perfectly.
 *
 * UNTESTED by the suite, and deliberately recorded as such: a hostile document
 * fails closed either way, so nothing in CI changes when this is removed. The
 * difference is host memory, which an in-process test cannot observe. The
 * evidence is the measurement above, taken with /usr/bin/time.
 */
const MAX_RENDER_MEMORY_KB = 1024 * 1024

/**
 * Resolution the page is rendered at for the model, in dots per inch.
 *
 * Too low a resolution makes the model read the year-to-date column instead of
 * the current month. The failure is not about reading digits — the model sees
 * the YTD figures perfectly. It cannot always resolve WHICH
 * COLUMN a figure sits under, and column position is the only thing separating
 * this month's pay from the tax year's. Resolution alone does not fix it
 * either: with a prompt that does not name the column, no resolution
 * suffices. It takes a prompt that names the column to read, AND enough resolution to
 * tell the columns apart.
 *
 * 400 rather than 300 for margin above a failure point that lies below 300 —
 * a misread here is silent. Drop to 300 if the payload matters:
 * a page is ~355KB at 200, ~650KB at 300 and ~975KB at 400.
 */
export const RENDER_DPI = 400

/**
 * The render is bounded by a TOTAL PIXEL BUDGET, at true RENDER_DPI where it
 * fits.
 *
 * Three attempts at this, each fixing the last one's blind spot:
 *
 *   -r N          sizes the raster from the DECLARED page box, which nothing
 *                 validates. ImageMagick writes the pixel count as the page
 *                 size, so a 600dpi A4 scan converted by it declares a page of
 *                 4960x7016 POINTS — ~70x the area of A4. Memory goes as page
 *                 area x dpi², so that page fails under MAX_RENDER_MEMORY_KB at
 *                 200dpi AND at 400.
 *
 *   -scale-to N   fits the LONG edge to N, so cost stops depending on the
 *                 file's claims — but effective dpi then depends on the page's
 *                 ASPECT RATIO, and it is the SHORT edge that carries the
 *                 columns. Measured at N=4678: A4 400dpi (by construction),
 *                 Letter 425, Legal 334, A3 283, and a 600x4000pt page — an
 *                 ordinary "share as PDF" export from a phone banking app — a
 *                 mere 84dpi, 702px across. Below 300 the model reads digits
 *                 perfectly and still cannot tell WHICH COLUMN they sit under,
 *                 which is the silent wrong-income failure this whole path
 *                 exists to prevent. It renders, it looks fine, and nothing
 *                 signals it.
 *
 *   this          computes both axes at true RENDER_DPI from the CropBox, and
 *                 only if that exceeds MAX_RENDER_PIXELS scales both down to
 *                 fit. Every normally-shaped page therefore renders at exactly
 *                 the resolution the 8/8 accuracy corpus was measured at, and
 *                 the pathological page is bounded by a number WE choose rather
 *                 than one the file declares.
 *
 * The budget was set by measuring AT the budget, because a linear fit over
 * small pages does not extrapolate to it. Peak RSS on ordinary shapes runs
 * ~4MB/Mpx (A4 77MB, Legal 90MB, A3 136MB, the phone screenshot 301MB at full
 * 400dpi), but at the cap a page CARRYING AN IMAGE costs far more than that
 * line predicts — Splash allocates full-size intermediates that do not show up
 * proportionally at smaller sizes:
 *
 *              text-only page      page with an image
 *   120 Mpx        477MB                 815MB   (20% headroom — too thin)
 *    90 Mpx        360MB                 615MB   (40% headroom)
 *
 * The 477MB text-only figure is not the cost at the cap. It is a real
 * measurement of an unrepresentative fixture: any page that large in the wild
 * is a scan, and a scan carries an image. Image-bearing constructions, high and
 * low entropy alike, reach 833MB, which is why the cap is 90 Mpx and not 120M.
 *
 * 90 Mpx still admits every realistic document at true RENDER_DPI — the largest
 * is the phone screenshot at 74 Mpx — so the reduction costs nothing but
 * pathological pages, which get proportionally fewer pixels and are unreadable
 * at any size.
 *
 * Decode does NOT add to this: measured, cost tracks the OUTPUT target and not
 * the source, because poppler scales the JPEG decode rather than materialising
 * the source. A 0.95MB fixture declaring a 16000x16000 image renders fine.
 *
 * Two independent backstops remain for what this arithmetic cannot foresee, and
 * both fail closed: MAX_RENDER_MEMORY_KB, and poppler's own refusal of any
 * dimension over 65500px (it exits non-zero, so execFileSync throws).
 */
export const MAX_RENDER_PIXELS = 90_000_000

/**
 * Page 1's CropBox in points — the box that is actually rendered.
 *
 * pdfinfo is a poppler tool reading the same untrusted file, so it gets the
 * same address-space ceiling. Its stderr is discarded for the same reason the
 * render's is: a document that provokes thousands of syntax errors emits
 * gigabytes of them and overflows the pipe buffer.
 *
 * stdout is NOT as small as it looks, which is the one way this seam differs
 * from the render's. pdfinfo echoes the Info dictionary — Title, Author,
 * Subject, Keywords — as plain text BEFORE it reaches CropBox, and pdftoppm
 * never surfaced document metadata at all because it writes an image to a file.
 * So a single oversized metadata field exhausts maxBuffer and throws ENOBUFS on
 * a document whose geometry is perfectly ordinary. Measured: a 2MB /Title
 * produces 2MB of stdout, and the CropBox line is still in there, unread.
 *
 * 8MB rather than 1MB because the failure that matters here is refusing a
 * REAL document: OCR tools do stuff extracted text into Keywords, and a
 * 100KB dump of it is entirely plausible (measured fine at either size, but
 * the margin is the point). A field large enough to beat 8MB still fails, and
 * fails closed. If you are ever debugging "PDF conversion failed: ENOBUFS" on
 * a document with unremarkable geometry, look at its metadata, not the CropBox
 * arithmetic.
 */
function cropBoxPt(pdfPath: string, execFileSync: typeof import('child_process').execFileSync): { widthPt: number; heightPt: number; quarterTurned: boolean } {
  const out = execFileSync(
    'sh',
    ['-c', `ulimit -v ${MAX_RENDER_MEMORY_KB}; exec pdfinfo -box "$1"`, 'sh', pdfPath],
    { timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
  )
  const box = /^CropBox:\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/m.exec(out)
  if (!box) throw new Error('could not read the page box')
  const widthPt = Number(box[3]) - Number(box[1])
  const heightPt = Number(box[4]) - Number(box[2])
  if (!(widthPt > 0) || !(heightPt > 0)) throw new Error(`page box is ${widthPt}x${heightPt}pt`)
  // -scale-to-x/-scale-to-y size the page BEFORE /Rotate is applied, and poppler
  // swaps the output afterwards. So the render arguments come from the box as
  // pdfinfo reports it, unrotated, while the dimensions to EXPECT BACK are
  // swapped on a quarter turn. Getting this backwards makes the guard refuse a
  // perfectly good document — a scanner routinely emits an upright page as a
  // portrait box plus /Rotate 90. Established by measurement, in both
  // directions, after reasoning about it produced the wrong answer twice.
  const rot = /^Page rot:\s+(-?\d+)/m.exec(out)
  const quarterTurned = rot ? Math.abs(Number(rot[1])) % 180 === 90 : false
  return { widthPt, heightPt, quarterTurned }
}

/**
 * Pixel dimensions to render a page of this size at, at RENDER_DPI where the
 * budget allows and proportionally reduced where it does not.
 *
 * Both axes are scaled by the same factor, so the page shape is preserved and
 * the short edge can never collapse the way -scale-to let it.
 */
export function renderTargetPx(widthPt: number, heightPt: number): { widthPx: number; heightPx: number } {
  const full = (pt: number) => Math.ceil((pt / 72) * RENDER_DPI)
  let widthPx = full(widthPt)
  let heightPx = full(heightPt)
  const pixels = widthPx * heightPx
  if (pixels > MAX_RENDER_PIXELS) {
    const scale = Math.sqrt(MAX_RENDER_PIXELS / pixels)
    widthPx = Math.max(1, Math.floor(widthPx * scale))
    heightPx = Math.max(1, Math.floor(heightPx * scale))
  }
  return { widthPx, heightPx }
}

/**
 * Reads the pixel dimensions out of a JPEG's frame header, or 0x0 if absent.
 *
 * SOF0/SOF2 carries height then width, big-endian. Every marker before the
 * frame header has a 2-byte length, and the length-less RST markers only ever
 * appear inside entropy-coded data, which follows it.
 */
export function jpegSizePx(jpeg: Buffer): { widthPx: number; heightPx: number } {
  let i = 2
  while (i < jpeg.length - 9) {
    if (jpeg[i] !== 0xff) { i++; continue }
    const marker = jpeg[i + 1]
    if (marker === 0xc0 || marker === 0xc2) {
      return { heightPx: jpeg.readUInt16BE(i + 5), widthPx: jpeg.readUInt16BE(i + 7) }
    }
    i += 2 + jpeg.readUInt16BE(i + 2)
  }
  return { widthPx: 0, heightPx: 0 }
}

/**
 * Whether the render is the page that was asked for, or the stub of one poppler
 * refused.
 *
 * Both axes are checked against the requested size, because a render can be
 * full-length and still collapsed across the short edge. Tolerance is one pixel
 * for poppler's own rounding; the case being caught is 1px, not 4600px.
 */
export function isFullPageRender(jpeg: Buffer, target: { widthPx: number; heightPx: number }): boolean {
  const got = jpegSizePx(jpeg)
  return Math.abs(got.widthPx - target.widthPx) <= 1 && Math.abs(got.heightPx - target.heightPx) <= 1
}


/**
 * The document as an image: a PDF's first page rendered to JPEG, an image as
 * it is. The face comparison reads a PDF ID through this too, so it sees the
 * page the VLM sees.
 */
export async function documentImage(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<{ ok: true; buffer: Buffer; mimeType: string } | { ok: false; error: string }> {
  let imageBuffer = fileBuffer
  let imageMime = mimeType
  if (mimeType === 'application/pdf') {
    try {
      const { execFileSync } = await import('child_process')
      const { writeFileSync, readFileSync } = await import('fs')
      const { join } = await import('path')
      // The directory is what protects the rendered JPEG: pdftoppm creates it
      // with its own umask, so no mode we set on our side would cover it.
      // Cleanup is the directory's, and runs on failure too — three client
      // documents would be stranded in /tmp if it didn't.
      await withPrivateTempDir(async (dir) => {
        const tmpIn = join(dir, 'in.pdf')
        const tmpOutPrefix = join(dir, 'out')
        writeFileSync(tmpIn, fileBuffer, { mode: 0o600 })
        // -cropbox: without it the model is shown the MediaBox, which can carry
        // content no PDF viewer displays — figures a reviewer comparing the
        // extraction against the document would never see. Predates the text
        // path; it makes the image itself untrustworthy as "what the page says".
        // Bounded memory, and stdio discarded. The tool writes to a file, so
        // its output is diagnostics only — and a document that provokes
        // thousands of syntax errors emits gigabytes of them (measured: 2.5GB),
        // overflowing Node's 1MB default pipe buffer and throwing ENOBUFS,
        // which fails extraction on a page that renders perfectly well.
        // Both axes are sized here rather than left to -r or -scale-to: -r
        // takes them from a page box the file declares and nothing checks, and
        // -scale-to fits only the LONG edge, which lets the short edge — where
        // the columns are — collapse on an elongated page.
        const { widthPt, heightPt, quarterTurned } = cropBoxPt(tmpIn, execFileSync)
        const target = renderTargetPx(widthPt, heightPt)
        // What comes back is the target turned a quarter, if the page is.
        const expected = quarterTurned
          ? { widthPx: target.heightPx, heightPx: target.widthPx }
          : target
        execFileSync(
          'sh',
          [
            '-c',
            `ulimit -v ${MAX_RENDER_MEMORY_KB}; ` +
              `exec pdftoppm -scale-to-x ${target.widthPx} -scale-to-y ${target.heightPx} ` +
              `-jpeg -cropbox -singlefile "$1" "$2"`,
            'sh',
            tmpIn,
            tmpOutPrefix,
          ],
          { timeout: 15000, stdio: 'ignore' },
        )
        imageBuffer = readFileSync(`${tmpOutPrefix}.jpg`)
        // pdftoppm can FAIL AND EXIT 0. On a page it cannot allocate it prints
        // "Bogus memory allocation size" to stderr — which is discarded here,
        // deliberately, because a hostile file emits gigabytes of it — and
        // still writes a valid 1x1 JPEG. Measured, not theorised: 631 bytes,
        // 1x1 px, exit 0. Without this check that pixel is sent to the model as
        // the payslip, and whatever it answers about a white dot becomes
        // someone's income, carrying no marker that anything went wrong.
        // Checked on BOTH axes against the size actually requested, because a
        // render can be full-length and still collapsed across the short edge.
        if (!isFullPageRender(imageBuffer, expected)) {
          const got = jpegSizePx(imageBuffer)
          throw new Error(
            `render produced ${got.widthPx}x${got.heightPx}px, expected ` +
              `${expected.widthPx}x${expected.heightPx}px ` +
              `(pdftoppm exits 0 on an allocation it refused)`,
          )
        }
        imageMime = 'image/jpeg'
      })
    } catch (err) {
      return { ok: false, error: `PDF conversion failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { ok: true, buffer: imageBuffer, mimeType: imageMime }
}

async function toVlmImageDataUrl(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  const image = await documentImage(fileBuffer, mimeType)
  if (!image.ok) return image
  return { ok: true, dataUrl: `data:${image.mimeType};base64,${image.buffer.toString('base64')}` }
}

/**
 * Main extraction function — calls VLM and returns structured ExtractedFields.
 *
 * When `referenceImage` is provided for a SELFIE, the request carries BOTH
 * images (selfie first, ID document second) and uses the face-match prompt:
 * the VLM is the biometric provider, comparing the live selfie against the
 * printed ID photograph.
 */
export async function extractDocumentData(opts: {
  fileBuffer: Buffer
  mimeType: string
  docType: string
  referenceImage?: { fileBuffer: Buffer; mimeType: string }
}): Promise<{
  ok: boolean
  data?: ExtractedFields
  error?: string
}> {
  const { fileBuffer, mimeType, docType, referenceImage } = opts
  const faceMatchMode = docType === 'SELFIE' && referenceImage !== undefined
  const prompt = faceMatchMode
    ? VLM_PROMPTS.SELFIE_FACE_MATCH
    : VLM_PROMPTS[docType] || VLM_PROMPTS.OTHER
  const vlmConfig = getVlmConfig()
  if (!vlmConfig) {
    return { ok: false, error: 'AI document extraction is not configured; manual review required' }
  }

  // Prefer the PDF's own text layer for figure-bearing documents. Falls through
  // to the image path when the file is a scan, a photo, or otherwise carries no
  // usable text — which is the majority of what clients upload from a phone.
  const documentParts: Array<
    { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string }
  > = []
  // The rendered page always goes, so the model sees what a human reviewer sees.
  const primaryImage = await toVlmImageDataUrl(fileBuffer, mimeType)
  if (!primaryImage.ok) return { ok: false, error: primaryImage.error }
  documentParts.push({ type: 'image_url', image_url: { url: primaryImage.dataUrl } })

  if (referenceImage) {
    const reference = await toVlmImageDataUrl(referenceImage.fileBuffer, referenceImage.mimeType)
    if (!reference.ok) return { ok: false, error: reference.error }
    documentParts.push({ type: 'image_url', image_url: { url: reference.dataUrl } })
  }

  try {
    const res = await fetch(vlmConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(55000),
      body: JSON.stringify({
        model: vlmConfig.model,
        messages: [
          {
            role: 'user',
            content: [
              ...documentParts,
              { type: 'text', text: prompt },
            ],
          },
        ],
        max_tokens: 1000,
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      return { ok: false, error: `VLM responded ${res.status}: ${text.slice(0, 200)}` }
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content: string = json.choices?.[0]?.message?.content ?? ''

    const rawData = parseVlmResponse(content)
    if (Object.keys(rawData).length === 0) {
      return { ok: false, error: 'Could not parse extraction result' }
    }

    let fields = mapExtractedFields(rawData, docType)

    // ID-specific post-processing
    if (docType === 'ID_COPY') {
      fields = applyIdValidationPostProcessing(fields, docType)
    }
    if (docType === 'PAYSLIP') {
      fields = applyPayslipPostProcessing(fields, docType)
    }
    fields = applyBankProductPostProcessing(fields, docType)

    return { ok: true, data: fields }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'VLM request timed out after 55s' }
    }
    return { ok: false, error: String(err) }
  }
}
