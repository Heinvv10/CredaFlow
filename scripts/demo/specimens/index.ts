/**
 * Generates one persona's specimen documents and their manifest.
 *
 * The manifest records, per file, the upload docType/MIME the app expects,
 * the SHA-256 of the bytes, and the values a correct extraction must return —
 * the ground truth verify-vlm.ts scores the real VLM against.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Persona } from '../personas/types'
import { bankStatementExpectation, renderBankStatement } from './bank-statement'
import { idCardExpectation, renderIdCard } from './id-card'
import { type CalendarDate, isoDate, lastThreePayDates, parseIsoDate, statementPeriod } from './pay-schedule'
import { payslipExpectation, renderPayslip } from './payslip'
import { buildStatement } from './statement-lines'

export type SpecimenDocType = 'ID_COPY' | 'PAYSLIP' | 'BANK_STATEMENT'

export interface ManifestDocument {
  file: string
  docType: SpecimenDocType
  mimeType: 'image/png' | 'application/pdf'
  sha256: string
  expected: Record<string, string | number>
}

export interface PersonaManifest {
  personaId: string
  kind: Persona['kind']
  storyline: Persona['storyline']
  summary: string
  asOf: string
  documents: ManifestDocument[]
  persona: Persona
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface SpecimenOptions {
  /**
   * The presenter's portrait, printed on LIVE-DEMO personas' ID cards only
   * (see presenter-photo.ts); background personas always get the photo-less
   * card. Omitted (the bake) → every card is photo-less.
   */
  presenterPhoto?: Buffer
}

export async function generateSpecimens(
  p: Persona,
  asOfIso: string,
  outRoot: string,
  opts: SpecimenOptions = {},
): Promise<PersonaManifest> {
  const asOf: CalendarDate = parseIsoDate(asOfIso)
  const dir = join(outRoot, p.id)
  mkdirSync(dir, { recursive: true })
  const documents: ManifestDocument[] = []
  const write = (file: string, bytes: Uint8Array, doc: Omit<ManifestDocument, 'file' | 'sha256'>): void => {
    writeFileSync(join(dir, file), bytes)
    documents.push({ file, sha256: sha256(bytes), ...doc })
  }

  const photo = p.kind === 'live-demo' ? opts.presenterPhoto : undefined
  write('id-card.png', await renderIdCard(p, photo), {
    docType: 'ID_COPY',
    mimeType: 'image/png',
    expected: { ...idCardExpectation(p) },
  })

  const payDates = lastThreePayDates(asOf, p.employment.salaryPaymentDay)
  for (const pay of payDates) {
    write(`payslip-${isoDate(pay).slice(0, 7)}.pdf`, await renderPayslip(p, pay), {
      docType: 'PAYSLIP',
      mimeType: 'application/pdf',
      expected: { ...payslipExpectation(p, pay) },
    })
  }

  const period = statementPeriod(payDates, asOf)
  const statement = buildStatement(p, payDates, period.end)
  write(`bank-statement-${isoDate(period.end).slice(0, 7)}.pdf`, await renderBankStatement(p, period, statement), {
    docType: 'BANK_STATEMENT',
    mimeType: 'application/pdf',
    expected: { ...bankStatementExpectation(p, period) },
  })

  const manifest: PersonaManifest = {
    personaId: p.id,
    kind: p.kind,
    storyline: p.storyline,
    summary: p.summary,
    asOf: asOfIso,
    documents,
    persona: p,
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
