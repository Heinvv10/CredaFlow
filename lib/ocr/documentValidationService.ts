/**
 * Document Validation Service
 * Compares VLM-extracted data against client records to detect mismatches.
 */

import { prisma } from '@/lib/prisma'
import { canonicalBankName } from '@/lib/banks'

export interface ValidationMismatch {
  field: string
  label: string
  documentValue: string | null
  recordValue: string | null
  severity: 'critical' | 'warning' | 'info'
  message: string
}

export interface ValidationResult {
  isValid: boolean
  matchScore: number // 0-100
  mismatches: ValidationMismatch[]
  matches: string[]
}

/** Mirrors lib/vlm-extract.ts ExtractedField — see the note there on why
 *  there is no per-field confidence. */
export interface ExtractedFields {
  [key: string]: {
    value: unknown
    validated: boolean
  }
}

function normalizeString(value: string | null | undefined): string {
  if (!value) return ''
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

// Name matching lives in its own module — see `lib/ocr/name-matching.ts`.
// Imported for use below, and re-exported so existing importers of this file
// are unaffected.
import { areNamesSimilar } from './name-matching'
export { areNamesSimilar }


function normalizeIdNumber(id: string | null | undefined): string {
  if (!id) return ''
  return id.replace(/[\s\-]/g, '')
}

function fieldValue(fields: ExtractedFields, key: string): string {
  const f = fields[key]
  if (!f || f.value === null || f.value === undefined) return ''
  return String(f.value)
}

/**
 * Validate extracted document data against the client record.
 */
export async function validateDocumentAgainstClient(
  extractedFields: ExtractedFields,
  docType: string,
  clientId: string,
  db: { client: unknown } = prisma,
): Promise<ValidationResult> {
  const client = await (db.client as typeof prisma.client).findUnique({
    where: { id: clientId },
    select: {
      idNumber: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      bankAccountNumber: true,
      bankName: true,
      employerName: true,
      monthlyIncome: true,
      grossMonthlyIncome: true,
      addressLine1: true,
      city: true,
    },
  })

  if (!client) {
    return { isValid: true, matchScore: 100, mismatches: [], matches: [] }
  }

  const mismatches: ValidationMismatch[] = []
  const matches: string[] = []

  switch (docType) {
    case 'ID_COPY':
      validateIdCopy(extractedFields, client, mismatches, matches)
      break
    case 'BANK_STATEMENT':
      validateBankStatement(extractedFields, client, mismatches, matches)
      break
    case 'PAYSLIP':
      validatePayslip(extractedFields, client, mismatches, matches)
      break
    case 'PROOF_OF_ADDRESS':
      validateProofOfAddress(extractedFields, client, mismatches, matches)
      break
    case 'SELFIE':
      // No cross-check needed
      return { isValid: true, matchScore: 100, mismatches: [], matches: [] }
    default:
      return { isValid: true, matchScore: 100, mismatches: [], matches: [] }
  }

  return calculateResult(mismatches, matches)
}

interface ClientRecord {
  idNumber: string
  firstName: string
  lastName: string
  dateOfBirth: Date | null
  bankAccountNumber: string | null
  bankName: string | null
  employerName: string | null
  monthlyIncome: number
  grossMonthlyIncome: number | null
  addressLine1: string | null
  city: string | null
}

function validateIdCopy(
  fields: ExtractedFields,
  client: ClientRecord,
  mismatches: ValidationMismatch[],
  matches: string[]
): void {
  // ID Number — critical
  const docId = normalizeIdNumber(fieldValue(fields, 'documentNumber') || fieldValue(fields, 'idNumber'))
  const recordId = normalizeIdNumber(client.idNumber)

  if (docId && recordId) {
    if (docId === recordId) {
      matches.push('SA ID Number')
    } else {
      mismatches.push({
        field: 'idNumber',
        label: 'SA ID Number',
        documentValue: docId,
        recordValue: recordId,
        severity: 'critical',
        message: `ID Number mismatch: Document shows "${docId}", client record has "${recordId}"`,
      })
    }
  }

  // Name — warning
  const docName = [fieldValue(fields, 'firstName'), fieldValue(fields, 'surname')].filter(Boolean).join(' ')
  const clientName = `${client.firstName} ${client.lastName}`

  if (docName && clientName) {
    if (areNamesSimilar(docName, clientName)) {
      matches.push('Name')
    } else {
      mismatches.push({
        field: 'fullName',
        label: 'Name',
        documentValue: docName,
        recordValue: clientName,
        severity: 'warning',
        message: `Name mismatch: Document shows "${docName}", client record has "${clientName}"`,
      })
    }
  }

  // DOB — warning
  const docDob = fieldValue(fields, 'dateOfBirth')
  if (docDob && client.dateOfBirth) {
    const clientDob = client.dateOfBirth.toISOString().split('T')[0]
    if (docDob === clientDob) {
      matches.push('Date of Birth')
    } else {
      mismatches.push({
        field: 'dateOfBirth',
        label: 'Date of Birth',
        documentValue: docDob,
        recordValue: clientDob ?? null,
        severity: 'warning',
        message: `DOB mismatch: Document shows "${docDob}", client record has "${clientDob}"`,
      })
    }
  }
}

function validateBankStatement(
  fields: ExtractedFields,
  client: ClientRecord,
  mismatches: ValidationMismatch[],
  matches: string[]
): void {
  // Account number — critical
  const docAccount = (fieldValue(fields, 'accountNumber')).replace(/[\s\-]/g, '')
  const clientAccount = (client.bankAccountNumber || '').replace(/[\s\-]/g, '')

  if (docAccount && clientAccount) {
    if (docAccount === clientAccount) {
      matches.push('Account Number')
    } else {
      mismatches.push({
        field: 'accountNumber',
        label: 'Account Number',
        documentValue: docAccount,
        recordValue: clientAccount,
        severity: 'critical',
        message: `Account number mismatch: Document shows "${docAccount}", client record has "${clientAccount}"`,
      })
    }
  }

  // Bank name — warning.
  //
  // Uses canonicalBankName, the SAME comparator as the disbursement gate and
  // its Postgres twin, rather than the substring test that used to live here.
  // That test compared raw strings, so a client correctly recorded as "FNB"
  // with a statement printing "First National Bank" satisfied neither
  // containment direction and was reported as a mismatch — a warning the
  // reviewer then had to dismiss on every FNB client. Three comparators for one
  // field is how they drift; there is now one.
  const docBank = canonicalBankName(fieldValue(fields, 'bankName') ?? '')
  const clientBank = canonicalBankName(client.bankName ?? '')

  if (docBank && clientBank) {
    if (docBank === clientBank) {
      matches.push('Bank Name')
    } else {
      mismatches.push({
        field: 'bankName',
        label: 'Bank Name',
        documentValue: fieldValue(fields, 'bankName'),
        recordValue: client.bankName,
        severity: 'warning',
        message: `Bank name mismatch: Document shows "${fieldValue(fields, 'bankName')}", client record has "${client.bankName}"`,
      })
    }
  }

  // Account holder name — warning
  const docHolder = fieldValue(fields, 'accountHolder')
  const clientName = `${client.firstName} ${client.lastName}`

  if (docHolder) {
    if (areNamesSimilar(docHolder, clientName)) {
      matches.push('Account Holder Name')
    } else {
      mismatches.push({
        field: 'accountHolder',
        label: 'Account Holder',
        documentValue: docHolder,
        recordValue: clientName,
        severity: 'warning',
        message: `Account holder mismatch: Document shows "${docHolder}", client record has "${clientName}"`,
      })
    }
  }
}

function validatePayslip(
  fields: ExtractedFields,
  client: ClientRecord,
  mismatches: ValidationMismatch[],
  matches: string[]
): void {
  // Employer name — warning
  const docEmployer = normalizeString(fieldValue(fields, 'employerName'))
  const clientEmployer = normalizeString(client.employerName)

  if (docEmployer && clientEmployer) {
    if (docEmployer.includes(clientEmployer) || clientEmployer.includes(docEmployer) || docEmployer === clientEmployer) {
      matches.push('Employer Name')
    } else {
      mismatches.push({
        field: 'employerName',
        label: 'Employer Name',
        documentValue: fieldValue(fields, 'employerName'),
        recordValue: client.employerName,
        severity: 'warning',
        message: `Employer mismatch: Document shows "${fieldValue(fields, 'employerName')}", client record has "${client.employerName}"`,
      })
    }
  }

  // Income — warning (within 20%), gross against gross and net against net.
  // Comparing the payslip's GROSS against Client.monthlyIncome (which holds NET)
  // flagged every correctly-extracted payslip: the two differ by the whole
  // deductions line, so a clean R40,123.45 / R26,543.21 payslip read as 50% out
  // and showed a 0% match badge. A pair is only compared when both sides exist —
  // grossMonthlyIncome is nullable and an absent record value proves nothing.
  const incomePairs: Array<{ field: string; label: string; doc: number; record: number }> = [
    {
      field: 'grossIncome',
      label: 'Gross Income',
      doc: Number(fieldValue(fields, 'grossIncome')) || 0,
      record: client.grossMonthlyIncome ?? 0,
    },
    {
      field: 'netIncome',
      label: 'Net Income',
      doc: Number(fieldValue(fields, 'netIncome')) || 0,
      record: client.monthlyIncome,
    },
  ]

  for (const { field, label, doc, record } of incomePairs) {
    if (doc <= 0 || record <= 0) continue
    const ratio = doc / record
    if (ratio >= 0.8 && ratio <= 1.2) {
      matches.push(label)
    } else {
      mismatches.push({
        field,
        label,
        documentValue: `R ${(doc / 100).toFixed(2)}`,
        recordValue: `R ${(record / 100).toFixed(2)}`,
        severity: 'warning',
        message: `Income differs by more than 20%: Document shows R ${(doc / 100).toFixed(2)}, client record has R ${(record / 100).toFixed(2)}`,
      })
    }
  }
}

function validateProofOfAddress(
  fields: ExtractedFields,
  client: ClientRecord,
  mismatches: ValidationMismatch[],
  matches: string[]
): void {
  const docCategory = fieldValue(fields, 'documentCategory') || 'unknown'

  // Check document actually contains a residential address
  const hasAddress = fieldValue(fields, 'hasResidentialAddress')
  if (hasAddress === 'false' || String(hasAddress) === 'false') {
    mismatches.push({
      field: 'hasResidentialAddress',
      label: 'Residential Address',
      documentValue: 'No address found',
      recordValue: 'Required',
      severity: 'critical',
      message: `No residential address found in this document. A valid proof of address must show a physical street address for the named person.`,
    })
    return
  }

  // Cross-check address against client record if we have both
  const docAddress = fieldValue(fields, 'addressLine1')
  const docCity = fieldValue(fields, 'city')
  const clientAddress = client.addressLine1
  const clientCity = client.city

  if (docAddress && clientAddress) {
    const normDoc = normalizeString(String(docAddress))
    const normClient = normalizeString(String(clientAddress))
    if (normDoc && normClient && (normDoc.includes(normClient) || normClient.includes(normDoc) || normDoc === normClient)) {
      matches.push('Street Address')
    } else if (docCity && clientCity && normalizeString(String(docCity)) === normalizeString(String(clientCity))) {
      matches.push('City matches')
    } else {
      mismatches.push({
        field: 'address',
        label: 'Address',
        documentValue: `${docAddress}${docCity ? ', ' + docCity : ''}`,
        recordValue: `${clientAddress}${clientCity ? ', ' + clientCity : ''}`,
        severity: 'warning',
        message: `Address mismatch: Document shows "${docAddress}${docCity ? ', ' + docCity : ''}", client record has "${clientAddress}${clientCity ? ', ' + clientCity : ''}"`,
      })
    }
  }

  // FICA date check — document must be within 3 months (except lease = 12 months)
  const issueDate = fieldValue(fields, 'issueDate')
  if (issueDate) {
    const issued = new Date(String(issueDate))
    if (!isNaN(issued.getTime())) {
      const now = new Date()
      const diffMs = now.getTime() - issued.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)
      const isLease = String(docCategory).toLowerCase().includes('lease')
      const maxDays = isLease ? 365 : 92 // 3 months ≈ 92 days; lease = 12 months
      if (diffDays > maxDays) {
        const months = Math.floor(diffDays / 30)
        mismatches.push({
          field: 'issueDate',
          label: 'Document Date',
          documentValue: String(issueDate),
          recordValue: isLease ? 'Within 12 months (FICA)' : 'Within 3 months (FICA)',
          severity: 'critical',
          message: `Document is ${months} month${months !== 1 ? 's' : ''} old — FICA requires proof of address to be ${isLease ? 'within 12 months (lease agreements)' : 'within 3 months'}. Please upload a more recent document.`,
        })
      } else {
        matches.push('Document Date (within FICA limit)')
      }
    }
  }

  // Name cross-check — warning
  const docHolder = fieldValue(fields, 'accountHolder')
  const clientName = `${client.firstName} ${client.lastName}`

  if (docHolder && clientName) {
    if (areNamesSimilar(String(docHolder), clientName)) {
      matches.push('Account Holder Name')
    } else {
      mismatches.push({
        field: 'accountHolder',
        label: 'Account Holder Name',
        documentValue: String(docHolder),
        recordValue: clientName,
        severity: 'warning',
        message: `Name mismatch: Document shows "${docHolder}", client record has "${clientName}"`,
      })
    }
  }
}

function calculateResult(
  mismatches: ValidationMismatch[],
  matches: string[]
): ValidationResult {
  const totalFields = matches.length + mismatches.length
  const criticalMismatches = mismatches.filter(m => m.severity === 'critical').length
  const warningMismatches = mismatches.filter(m => m.severity === 'warning').length

  let matchScore = 100
  if (totalFields > 0) {
    matchScore = Math.max(0, Math.round(
      ((matches.length * 100) - (criticalMismatches * 50) - (warningMismatches * 20)) / totalFields
    ))
  }

  return {
    isValid: criticalMismatches === 0,
    matchScore,
    mismatches,
    matches,
  }
}
