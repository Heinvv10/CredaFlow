/**
 * Payslip extraction accuracy runner.
 *
 * Scores the REAL pipeline against human-read ground truth and reports per
 * field, so a prompt or pipeline change can be shown to help rather than argued
 * about. See README.md for why the corpus lives outside the repository.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AccuracyCase {
  file: string
  source?: string
  docType: string
  expect: Record<string, string | number>
  /** Wrong values printed on the same rows — usually the year-to-date column. */
  traps?: Record<string, string | number>
}

export interface FieldOutcome {
  field: string
  /** `trap` means the pipeline read a real number off the WRONG column. */
  status: 'correct' | 'trap' | 'wrong' | 'missing'
  expected: string | number
  actual: unknown
}

export interface CaseOutcome {
  file: string
  error?: string
  fields: FieldOutcome[]
}

export function loadManifest(corpusDir: string): AccuracyCase[] {
  const raw = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8')) as {
    cases?: AccuracyCase[]
  }
  return raw.cases ?? []
}

/**
 * Compare one extraction against ground truth.
 *
 * Kept free of I/O so the scoring itself is unit-testable — the classifier is
 * the part that must not be wrong, since every number in the report comes from
 * it. Values are compared as strings after trimming, except numbers, which are
 * compared numerically so 2100000 and "2100000" agree.
 */
export function scoreCase(
  testCase: AccuracyCase,
  extracted: Record<string, { value: unknown }> | null,
  error?: string,
): CaseOutcome {
  if (!extracted) return { file: testCase.file, error: error ?? 'extraction returned nothing', fields: [] }

  const same = (a: unknown, b: unknown): boolean => {
    if (a === null || a === undefined || b === null || b === undefined) return false
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') {
      return na === nb
    }
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
  }

  const fields = Object.entries(testCase.expect).map(([field, expected]): FieldOutcome => {
    const actual = extracted[field]?.value
    if (actual === undefined || actual === null || actual === '') {
      return { field, status: 'missing', expected, actual }
    }
    if (same(actual, expected)) return { field, status: 'correct', expected, actual }
    const trap = testCase.traps?.[field]
    if (trap !== undefined && same(actual, trap)) {
      return { field, status: 'trap', expected, actual }
    }
    return { field, status: 'wrong', expected, actual }
  })

  return { file: testCase.file, fields }
}

/** Human-readable report. Traps are called out separately — they are a different bug. */
export function formatReport(outcomes: CaseOutcome[]): string {
  const lines: string[] = []
  const tally = { correct: 0, trap: 0, wrong: 0, missing: 0 }

  for (const outcome of outcomes) {
    lines.push(`\n${outcome.file}`)
    if (outcome.error) {
      lines.push(`  EXTRACTION FAILED: ${outcome.error}`)
      continue
    }
    for (const f of outcome.fields) {
      tally[f.status] += 1
      const mark = { correct: 'ok  ', trap: 'TRAP', wrong: 'WRONG', missing: 'none' }[f.status]
      const detail = f.status === 'correct' ? '' : `  expected ${f.expected}, got ${JSON.stringify(f.actual)}`
      lines.push(`  ${mark}  ${f.field}${detail}`)
    }
  }

  const scored = tally.correct + tally.trap + tally.wrong + tally.missing
  const pct = scored === 0 ? 0 : Math.round((tally.correct / scored) * 100)
  lines.push(
    `\n${tally.correct}/${scored} fields correct (${pct}%)` +
    `  |  ${tally.trap} read from the WRONG COLUMN  |  ${tally.wrong} wrong  |  ${tally.missing} missing`,
  )
  if (tally.trap > 0) {
    lines.push('A trap hit means a year-to-date figure was taken for this month — the failure this corpus exists to catch.')
  }
  return lines.join('\n')
}
