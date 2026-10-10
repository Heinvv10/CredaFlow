/**
 * Scores one extraction against a specimen's expected values.
 *
 * Each field is compared the way the APP compares it downstream, not by raw
 * string equality: names through areNamesSimilar, banks through
 * canonicalBankName, ID/account numbers as digits only, money as integer
 * cents. A field passes here only if the app would treat it as matching.
 */
import { canonicalBankName } from '@/lib/banks'
import { areNamesSimilar } from '@/lib/ocr/name-matching'
import type { ExtractedFields } from '@/lib/vlm-extract'

export interface FieldScore {
  field: string
  expected: string | number
  actual: unknown
  ok: boolean
  /** validated:false set by the app's own post-processing. */
  distrusted: boolean
}

const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '')
const flat = (v: unknown): string => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

function same(field: string, expected: string | number, actual: unknown): boolean {
  if (actual === undefined || actual === null || actual === '') return false
  switch (field) {
    case 'documentNumber':
    case 'employeeIdNumber':
    case 'accountNumber':
      return digits(actual) === digits(expected)
    case 'employeeName':
    case 'accountHolder':
      return areNamesSimilar(String(actual), String(expected))
    case 'bankName':
      return canonicalBankName(String(actual)) === canonicalBankName(String(expected))
    case 'grossIncome':
    case 'netIncome':
    case 'totalDeductions':
      // The app trusts only a number here (centsField in lib/vlm-extract.ts).
      return typeof actual === 'number' && actual === expected
    default:
      return flat(actual) === flat(expected)
  }
}

export function scoreExtraction(expected: Record<string, string | number>, fields: ExtractedFields): FieldScore[] {
  return Object.entries(expected).map(([field, want]) => {
    const got = fields[field]
    return {
      field,
      expected: want,
      actual: got?.value,
      ok: same(field, want, got?.value),
      distrusted: got?.validated === false,
    }
  })
}

/** Post-processing warnings the app attached (keys starting with "_"). */
export function warnings(fields: ExtractedFields): string[] {
  return Object.entries(fields)
    .filter(([key]) => key.startsWith('_'))
    .map(([key, f]) => `${key}: ${String(f.value)}`)
}
