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

/** The option labels of the staff client wizard (components/clients/wizard, lib/validation/client-wizard.ts). */
const PROVINCE_LABELS: Record<string, string> = {
  EC: 'Eastern Cape', FS: 'Free State', GP: 'Gauteng', KZN: 'KwaZulu-Natal', LP: 'Limpopo', MP: 'Mpumalanga', NC: 'Northern Cape', NW: 'North West', WC: 'Western Cape',
}
const EMPLOYMENT_LABELS: Record<string, string> = { EMPLOYED: 'Employed (full-time)', SALARY: 'Salary' }
const BANK_ACCOUNT_LABELS: Record<string, string> = { CHEQUE: 'Cheque / current', SAVINGS: 'Savings' }

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
    ['Address', `${a.addressLine1}, ${a.suburb}, ${a.city}, ${PROVINCE_LABELS[a.province] ?? a.province}, ${a.postalCode}`],
    ['Employment / income', `${EMPLOYMENT_LABELS[p.employment.employmentStatus] ?? p.employment.employmentStatus} / ${EMPLOYMENT_LABELS[p.employment.incomeSourceType] ?? p.employment.incomeSourceType}`],
    ['Employer', p.employment.employerName],
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
    ['Bank', `${p.bank.bankCode}, branch ${p.bank.branchCode}, account type "${BANK_ACCOUNT_LABELS[p.bank.accountType] ?? p.bank.accountType}", account ${p.bank.accountNumber}`],
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
  const payslips = documents.filter((d) => d.docType === 'PAYSLIP').map((d) => d.file).sort()
  const latestPayslip = payslips[payslips.length - 1]
  if (!latestPayslip) throw new Error(`${p.id}: the kit has no payslip`)
  const steps = stepsFor(p, latestPayslip)
  const returning = p.storyline === 'live-returning-client'
  return {
    title: `${p.firstName} ${p.lastName}: ${p.storyline}`,
    subtitle: p.summary,
    sections: [
      { heading: returning ? 'Details on file (check, do not re-type)' : 'Details to type', rows: detailRows(p) },
      { heading: 'Logins (by role)', items: loginItems(p) },
      { heading: 'Click path', numbered: true, items: steps.map((s) => `[${s.who}] ${s.where}: ${s.action} Expect: ${s.expect}`) },
      ...(returning ? [] : [{ heading: 'At the selfie step, say', quote: SELFIE_SCRIPT }]),
      {
        heading: returning ? 'Files in this folder (spare, not needed for this story)' : 'Files to upload (this folder)',
        items: documents.map((d) => {
          if (returning) return `${d.file} (${d.docType.replace('_', ' ').toLowerCase()}; spare, not needed for this story)`
          const spare = d.docType === 'PAYSLIP' && d.file !== latestPayslip ? '; spare, not needed' : ''
          const twice = d.docType === 'BANK_STATEMENT' ? '; also as proof of address' : ''
          return `${d.file} (${d.docType.replace('_', ' ').toLowerCase()}${spare}${twice})`
        }),
      },
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
    'Three storylines, one folder each: SPECIMEN documents (the returning client uploads nothing: hers are spare) and a one-page `CHEAT-SHEET.pdf` (same text in `CHEAT-SHEET.md`).',
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
    '- Restore the demo snapshot so all three personas are unused (the returning client keeps only her settled first loan). A restore signs everyone out.',
    '- Browsers: CREDIT OFFICER and ADMIN both work in the staff app, so give each its own browser profile (or one a private window) and keep both signed in; the client portal is a separate site. Staff pages do not update themselves when the other role or the borrower acts: refresh the application page before each staff step.',
    '- Camera: the selfie (new clients only) can only be taken with the camera (no file upload). Allow the camera for the portal site before the demo.',
    '- Waits (new clients; the returning client uploads nothing): each uploaded document takes 5 to 15 seconds to scan and the selfie match up to 20 seconds; everything else answers within a few seconds. Upload one document at a time and wait for "Document scanned" before the next (the extraction model is shared).',
    '- Known issue on build 0c362f0: on the portal signing page the frame that should show the PASQ + agreement packet shows `{"error":"Not found"}`, and so do its "Open PDF in a new tab" and "Download agreement" links. Signing still works. Show the packet from the staff app instead (application > Credit Agreement panel > View PASQ + Agreement).',
    '- Documents are dated for the as-of date above; rebuild the kit if you demo in a later month.',
    '- Logins are by role; the credentials are not in this kit (see each cheat sheet).',
    '- Portal activation: new clients activate the portal with a 6-digit one-time code. The demo shows that code on the activation screen instead of emailing it, but only on a deployment with DEMO_MODE set to exactly `true` and only for a `.invalid` address (every persona here has one; a real address typed in gets no code on screen). The same goes for a portal password reset.',
    '- `manifest.json` in each folder is the ground truth `verify-vlm.ts --out <this folder>` checks extraction against; it is not uploaded.',
    '',
  ].join('\n')
}
