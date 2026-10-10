/**
 * Run the app's REAL extraction and validation over generated specimens.
 *
 *   VLM_API_URL=http://127.0.0.1:8100 VLM_MODEL=<id> \
 *     npx tsx scripts/demo/specimens/verify-vlm.ts [--persona <id> | --all] [--out scripts/demo/.out] [--all-payslips]
 *
 * Defaults to the three live-demo personas (--all: every persona): ID card, latest payslip, bank
 * statement. For each document it calls extractDocumentData (lib/vlm-extract.ts),
 * scores every expected field, then runs validateDocumentAgainstClient — the
 * comparison the upload route runs — against the persona as the client record,
 * and for the statement the payout-gate check verifiedBankStatementEvidence.
 * Exits non-zero if any field, validation or gate fails.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { verifiedBankStatementEvidence } from '@/lib/compliance/debit-mandate'
import { validateDocumentAgainstClient } from '@/lib/ocr/documentValidationService'
import { extractDocumentData } from '@/lib/vlm-extract'
import { LIVE_DEMO_PERSONAS, PERSONAS, getPersona } from '../personas'
import type { Persona } from '../personas/types'
import type { ManifestDocument, PersonaManifest } from './index'
import { scoreExtraction, warnings } from './verify-compare'

const out = (line = ''): void => { process.stdout.write(`${line}\n`) }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** The persona as the Client row validateDocumentAgainstClient selects. */
function clientDb(p: Persona) {
  const record = {
    idNumber: p.idNumber,
    firstName: p.firstName,
    lastName: p.lastName,
    dateOfBirth: new Date(`${p.dateOfBirth}T00:00:00.000Z`),
    bankAccountNumber: p.bank.accountNumber,
    bankName: p.bank.bankCode,
    employerName: p.employment.employerName,
    monthlyIncome: p.payroll.netCents,
    grossMonthlyIncome: p.payroll.grossCents,
    addressLine1: p.address.addressLine1,
    city: p.address.city,
  }
  return { client: { findUnique: async () => record } }
}

function pickDocuments(m: PersonaManifest, allPayslips: boolean): ManifestDocument[] {
  const payslips = m.documents.filter((d) => d.docType === 'PAYSLIP')
  return m.documents.filter((d) => d.docType !== 'PAYSLIP' || allPayslips || d === payslips[payslips.length - 1])
}

async function verifyDocument(p: Persona, dir: string, doc: ManifestDocument): Promise<boolean> {
  const started = Date.now()
  const result = await extractDocumentData({
    fileBuffer: readFileSync(join(dir, doc.file)),
    mimeType: doc.mimeType,
    docType: doc.docType,
  })
  out(`\n### ${p.id} — ${doc.docType} — ${doc.file} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  if (!result.ok || !result.data) {
    out(`EXTRACTION FAILED: ${result.error ?? 'no data'}`)
    return false
  }
  const fields = result.data
  const scores = scoreExtraction(doc.expected, fields)
  out('| field | expected | extracted | match |')
  out('|---|---|---|---|')
  for (const s of scores) {
    out(`| ${s.field} | ${String(s.expected)} | ${JSON.stringify(s.actual) ?? '—'} | ${s.ok ? 'OK' : 'FAIL'}${s.distrusted ? ' (validated:false)' : ''} |`)
  }
  for (const w of warnings(fields)) out(`warning ${w}`)

  const validation = await validateDocumentAgainstClient(fields, doc.docType, p.id, clientDb(p))
  out(`app validation: isValid=${validation.isValid} score=${validation.matchScore} matches=[${validation.matches.join(', ')}]`)
  for (const m of validation.mismatches) out(`  mismatch (${m.severity}): ${m.message}`)
  let ok = scores.every((s) => s.ok && !s.distrusted) && validation.isValid && validation.mismatches.length === 0

  if (doc.docType === 'BANK_STATEMENT') {
    const gate = verifiedBankStatementEvidence(
      { id: `${p.id}-statement`, contentSha256: doc.sha256, verifiedAt: new Date(), extractionResult: fields, validationMismatch: !validation.isValid },
      { bankName: p.bank.bankCode, branchCode: p.bank.branchCode, accountNumber: p.bank.accountNumber, accountType: p.bank.accountType },
    )
    out(`payout gate (verifiedBankStatementEvidence): ${gate.ok ? 'ok' : `${gate.reason} ${gate.mismatchField ?? ''}`}`)
    ok = ok && gate.ok
  }
  return ok
}

async function main(): Promise<void> {
  if (!process.env.VLM_API_URL || !process.env.VLM_MODEL) throw new Error('set VLM_API_URL and VLM_MODEL')
  const root = resolve(arg('out') ?? 'scripts/demo/.out')
  const id = arg('persona')
  const personas = id ? [getPersona(id)] : process.argv.includes('--all') ? PERSONAS : LIVE_DEMO_PERSONAS
  let failures = 0
  for (const p of personas) {
    const dir = join(root, p.id)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PersonaManifest
    for (const doc of pickDocuments(manifest, process.argv.includes('--all-payslips'))) {
      if (!(await verifyDocument(p, dir, doc))) failures++
    }
  }
  out(`\n${failures === 0 ? 'ALL DOCUMENTS PASS' : `${failures} DOCUMENT(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
