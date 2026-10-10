/**
 * The presenter's one-page cheat sheet for a live-demo persona, as one model
 * rendered twice: Markdown here, PDF in cheat-sheet-pdf.ts.
 *
 * Logins are named by ROLE only; no password, TOTP secret or activation code
 * is ever written into a kit.
 */
import type { Persona } from '../personas/types'
import type { ManifestDocument } from '../specimens'
import { money } from '../specimens/pdf-kit'
import { CREDENTIALS_SOURCE } from './layout'
import { SELFIE_SCRIPT, purposeOf, stepsFor } from './stories'

export interface SheetSection {
  heading: string
  /** Label/value pairs. */
  rows?: Array<[string, string]>
  /** Numbered when `numbered`, else bullets. */
  items?: string[]
  numbered?: boolean
  quote?: string
}

export interface CheatSheet {
  title: string
  subtitle: string
  sections: SheetSection[]
}

const R = (cents: number): string => `R${money(cents)}`

const DEBT_LABELS: Record<string, string> = {
  HOME_LOAN: 'Home loan', VEHICLE_FINANCE: 'Vehicle finance', PERSONAL_LOAN: 'Personal loan', CREDIT_CARD: 'Credit card',
  STORE_ACCOUNT: 'Store account', CLOTHING_ACCOUNT: 'Clothing account', MICROFINANCE: 'Microfinance',
}

function detailRows(p: Persona): Array<[string, string]> {
  const a = p.address
  const e = p.expenses
  const purpose = purposeOf(p)
  const rows: Array<[string, string]> = [
    ['First name / Surname', `${p.firstName} / ${p.lastName}`],
    ['SA ID number', p.idNumber],
    ['Birth date / gender', `${p.dateOfBirth} / ${p.gender === 'MALE' ? 'Male' : 'Female'}`],
    ['Mobile (and WhatsApp)', p.phone],
    ['Email (portal login)', p.email],
    ['Address', `${a.addressLine1}, ${a.suburb}, ${a.city}, ${a.province} ${a.postalCode}`],
    ['Employer', `${p.employment.employerName} (${p.employment.occupation})`],
    ['Employer address', p.employment.employerAddress],
    ['Start date / pay day', `${p.employment.employmentStartDate} / day ${p.employment.salaryPaymentDay}`],
    ['Gross / net pay', `${R(p.payroll.grossCents)} / ${R(p.payroll.netCents)}`],
    ['Expenses', `Housing ${R(e.housing)}, transport ${R(e.transport)}, food ${R(e.food)}, education ${R(e.education)}, ` +
      `insurance ${R(e.insurance)}, clothing ${R(e.clothing)}, entertainment ${R(e.entertainment)}, medical ${R(e.medical)}, other ${R(e.other)}`],
  ]
  p.debts.forEach((d, i) => rows.push([
    `Debt ${i + 1}`,
    `${d.creditProvider}, ${DEBT_LABELS[d.accountType] ?? d.accountType}: balance ${R(d.outstandingBalanceCents)}, instalment ${R(d.monthlyInstalmentCents)}`,
  ]))
  rows.push(
    ['Bank', `${p.bank.bankCode}, branch ${p.bank.branchCode}, ${p.bank.accountType.toLowerCase()} account ${p.bank.accountNumber}`],
    ['Next of kin', `${p.nextOfKin.name} (${p.nextOfKin.relationship}), ${p.nextOfKin.phone}`],
    ['Loan to request', `Personal Loan ${R(p.loanRequest.amountCents)}, ${p.loanRequest.termDays} days (${Math.round(p.loanRequest.termDays / 30)} months)`],
    ['Purpose', `${purpose.category}: "${purpose.text}"`],
  )
  return rows
}

function loginItems(p: Persona): string[] {
  const portal = p.storyline === 'live-returning-client'
    ? `CLIENT (client portal): ${p.email}; the seed's client portal password (portal activated during the bake).`
    : `CLIENT (client portal): ${p.email}; the password you set when activating the portal in this demo.`
  return [
    'CREDIT OFFICER and ADMIN (staff app, password + 6-digit authenticator code).',
    portal,
    `Credentials: ${CREDENTIALS_SOURCE}. Never shown on screen.`,
  ]
}

export function cheatSheetFor(p: Persona, documents: readonly ManifestDocument[]): CheatSheet {
  const steps = stepsFor(p)
  return {
    title: `${p.firstName} ${p.lastName}: ${p.storyline}`,
    subtitle: p.summary,
    sections: [
      { heading: p.storyline === 'live-returning-client' ? 'Details on file (check, do not re-type)' : 'Details to type', rows: detailRows(p) },
      { heading: 'Logins (by role)', items: loginItems(p) },
      { heading: 'Click path', numbered: true, items: steps.map((s) => `[${s.who}] ${s.where}: ${s.action} Expect: ${s.expect}`) },
      { heading: 'At the selfie step, say', quote: SELFIE_SCRIPT },
      { heading: 'Files to upload (this folder)', items: documents.map((d) => `${d.file} (${d.docType.replace('_', ' ').toLowerCase()})`) },
    ],
  }
}

const cell = (text: string): string => text.replace(/\|/g, '\\|')

export function cheatSheetMarkdown(sheet: CheatSheet): string {
  const lines = [`# ${sheet.title}`, '', `_${sheet.subtitle}_`, '']
  for (const s of sheet.sections) {
    lines.push(`## ${s.heading}`, '')
    if (s.rows) lines.push('| Field | Value |', '|---|---|', ...s.rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`))
    if (s.items) lines.push(...s.items.map((item, i) => (s.numbered ? `${i + 1}. ${item}` : `- ${item}`)))
    if (s.quote) lines.push(`> ${s.quote}`)
    lines.push('')
  }
  lines.push('_Presenter notes. SPECIMEN persona; the ID card carries the presenter\'s real photo: do not share this folder._', '')
  return lines.join('\n')
}

export interface KitEntry {
  persona: Persona
  folder: string
}

export function kitReadme(asOf: string, entries: readonly KitEntry[]): string {
  return [
    `# CredaFlow live-demo kit (as of ${asOf})`,
    '',
    'Three storylines, one folder each: SPECIMEN documents to upload and a one-page `CHEAT-SHEET.pdf` (same text in `CHEAT-SHEET.md`).',
    'The ID cards carry the presenter\'s real photo so the live selfie genuinely face-matches. Keep this folder private (chmod 700), never commit or share it.',
    '',
    '## Suggested running order',
    '',
    ...entries.map((e, i) => `${i + 1}. **${e.persona.firstName} ${e.persona.lastName}** (\`${e.folder}/\`): ${e.persona.summary}`),
    '',
    'Run the approval first (it shows the whole path once), the decline second (the same capture, but the product itself refuses the loan), the returning client last (self-service from the portal).',
    '',
    '## Before you start',
    '',
    '- Restore the demo snapshot so all three personas are unused (the returning client keeps only her settled first loan).',
    '- Documents are dated for the as-of date above; rebuild the kit if you demo in a later month.',
    '- Logins are by role; the credentials are not in this kit (see each cheat sheet).',
    '- Activation code: new clients activate the portal with a 6-digit code emailed to their address. Persona addresses are `.invalid` and the demo sends no email, so have a way to read the code ready before the demo (open item from the kit build).',
    '- `manifest.json` in each folder is the ground truth `verify-vlm.ts --out <this folder>` checks extraction against; it is not uploaded.',
    '',
  ].join('\n')
}
