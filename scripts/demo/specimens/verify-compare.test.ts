import { describe, expect, it } from 'vitest'
import type { ExtractedFields } from '@/lib/vlm-extract'
import { scoreExtraction, warnings } from './verify-compare'

// Obviously synthetic values only.
const ID = '1234567890123'
const ACCOUNT = '0123456789'

function score(field: string, expected: string | number, actual: unknown, validated = true) {
  const fields: ExtractedFields = { [field]: { value: actual, validated } }
  const [s] = scoreExtraction({ [field]: expected }, fields)
  return s
}

describe('scoreExtraction', () => {
  it.each([
    // ID and account numbers: digits only, so spacing and labels do not matter
    ['documentNumber', ID, '123456 7890 123', true],
    ['documentNumber', ID, `ID: ${ID}`, true],
    ['documentNumber', ID, '1234567890124', false],
    ['employeeIdNumber', ID, '1234567890123', true],
    ['employeeIdNumber', ID, '123456789012', false],
    ['accountNumber', ACCOUNT, '0123-456-789', true],
    ['accountNumber', ACCOUNT, '123456789', false],
    // names: the app's areNamesSimilar (initials, title, order)
    ['employeeName', 'Lerato Specimen', 'L SPECIMEN', true],
    ['employeeName', 'Lerato Specimen', 'SPECIMEN LERATO', true],
    ['employeeName', 'Lerato Specimen', 'Sipho Example', false],
    ['accountHolder', 'Lerato Specimen', 'L. Specimen', true],
    ['accountHolder', 'Lerato Specimen', 'Lerato Other', false],
    // banks: canonicalBankName
    ['bankName', 'Standard Bank', 'STANDARD BANK OF SOUTH AFRICA', true],
    ['bankName', 'FNB', 'First National Bank', true],
    ['bankName', 'Standard Bank', 'Capitec Bank', false],
    // money: only an integer-cents number counts, never a string
    ['grossIncome', 2_500_000, 2_500_000, true],
    ['grossIncome', 2_500_000, '2500000', false],
    ['netIncome', 1_800_050, 'R18 000.50', false],
    ['netIncome', 1_800_050, 1_800_051, false],
    ['totalDeductions', 700_000, 700_000, true],
    ['totalDeductions', 700_000, 7_000, false],
    // anything else: case- and whitespace-insensitive text
    ['employerName', 'Acme Mining (Pty) Ltd', '  ACME   MINING (PTY) LTD ', true],
    ['employerName', 'Acme Mining (Pty) Ltd', 'Acme Minerals (Pty) Ltd', false],
  ] as const)('%s: expected %j, got %j → ok=%s', (field, expected, actual, ok) => {
    expect(score(field, expected, actual).ok).toBe(ok)
  })

  it.each(['documentNumber', 'accountNumber', 'employeeName', 'bankName', 'grossIncome', 'employerName'])(
    '%s: an empty extraction is a fail, never a match',
    (field) => {
      const expected = field === 'grossIncome' ? 0 : ''
      for (const empty of [undefined, null, '']) expect(score(field, expected, empty).ok).toBe(false)
    },
  )

  it('fails a field the extraction does not have at all', () => {
    const [s] = scoreExtraction({ documentNumber: ID }, {})
    expect(s).toMatchObject({ field: 'documentNumber', ok: false, actual: undefined, distrusted: false })
  })

  it('marks a field the app itself flagged validated:false as distrusted, without changing ok', () => {
    expect(score('documentNumber', ID, ID, false)).toMatchObject({ ok: true, distrusted: true })
    expect(score('documentNumber', ID, ID, true)).toMatchObject({ ok: true, distrusted: false })
  })
})

describe('warnings', () => {
  it('lists only the underscore-prefixed post-processing keys', () => {
    const fields: ExtractedFields = {
      _nameMismatch: { value: 'surname differs', validated: false },
      documentNumber: { value: ID, validated: true },
    }
    expect(warnings(fields)).toEqual(['_nameMismatch: surname differs'])
  })
})
