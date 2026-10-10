/**
 * The click path the presenter walks for each live-demo storyline.
 *
 * Who does what follows the origination scenario (scenarios/origination.ts
 * and the step modules it calls) and the route guards they document:
 * CREDIT_OFFICER captures, verifies documents, starts the bureau review,
 * assesses affordability, issues the PASQ and generates the agreement; ADMIN
 * records compliance, decides, countersigns and pays out; the borrower
 * activates the portal, uploads, acknowledges the PASQ and signs agreement and
 * mandate. One deliberate difference: the scenario records an in-person
 * identity check, the live demo takes a real selfie instead.
 *
 * Text stays inside WinAnsi (Helvetica in the PDF): no arrows, no symbols.
 */
import { BIOMETRIC_LIVENESS_THRESHOLD, BIOMETRIC_MATCH_THRESHOLD } from '@/lib/kyc/biometric-evidence'
import type { Persona } from '../personas/types'
import { money } from '../specimens/pdf-kit'

export type Actor = 'CREDIT OFFICER' | 'ADMIN' | 'CLIENT'

export interface Step {
  who: Actor
  where: string
  action: string
  expect: string
}

/**
 * What the decide route returned when the scenario tried to approve this
 * persona on the sim stack (T3 run, 2026-10-10). Amounts are in cents; they
 * move if the PERSONAL product's pricing, the bureau simulation or the
 * tenant's NDI buffer (110%) change.
 */
export const RECORDED_DECLINE_REASON =
  'Affordability gate: Net disposable income 180913 below required 283861 (instalment × 110%).'

/** The decline reason the scenario records (scenarios/decision.ts). */
const DECLINE_TEXT = 'Your existing monthly credit obligations leave too little disposable income for this instalment.'

const R = (cents: number): string => `R${money(cents)}`

/** The purpose the application wizard is given (scenarios/capture.ts submitApplication). */
export function purposeOf(p: Persona): { category: string; text: string } {
  return p.debts.length > 2
    ? { category: 'Debt consolidation', text: 'Consolidate store and card accounts' }
    : { category: 'Household', text: 'Household expenses and repairs' }
}

function loanTerms(p: Persona): string {
  return `Personal Loan, ${R(p.loanRequest.amountCents)} over ${p.loanRequest.termDays} days`
}

function documentsAndSelfie(p: Persona): Step[] {
  return [
    { who: 'CLIENT', where: 'Portal > Documents', action: 'Upload from this folder: id-card.png as ID document, the three payslips, the bank statement as bank statement, and the SAME bank statement again as proof of address (the specimens carry no utility bill; the proof-of-address prompt accepts a statement).', expect: 'Each row shows extraction running, then done; the app reads names, ID number, employer and pay off the documents.' },
    { who: 'CLIENT', where: 'Portal > Documents > Selfie verification > Take selfie', action: 'Take a live selfie of the presenter (front-facing, good light, nobody else in frame). See "At the selfie step" below.', expect: `"Identity checks passed and are awaiting advisor review" (match must be at least ${BIOMETRIC_MATCH_THRESHOLD}%, liveness at least ${BIOMETRIC_LIVENESS_THRESHOLD}%).` },
    { who: 'CREDIT OFFICER', where: `Clients > ${p.firstName} ${p.lastName} > KYC tab`, action: 'Open each document, compare the extraction with the client record, and verify the ID, payslips, bank statement, proof of address and the selfie.', expect: 'KYC checklist complete; the selfie shows its match percentage.' },
  ]
}

function reviewAndAffordability(): Step[] {
  return [
    { who: 'CREDIT OFFICER', where: 'Applications > the application', action: 'Start Review.', expect: 'Status UNDER_REVIEW; the credit bureau enquiry runs (simulated in the demo) and is stored on the Bureau tab.' },
    { who: 'CREDIT OFFICER', where: 'Application > Affordability Assessment', action: 'Confirm the debt obligations (pre-filled from the client record), then Save Affordability Assessment.', expect: 'The server recomputes net disposable income (NDI) after the new instalment.' },
    { who: 'ADMIN', where: 'Application > compliance checks', action: 'Tick the reckless-lending assessment and the client affordability declaration, then Confirm Assessment Checks.', expect: 'Checks recorded.' },
  ]
}

function approveToPayout(p: Persona): Step[] {
  return [
    { who: 'ADMIN', where: 'Application > decision panel', action: 'Repayment method Debit order, then Approve.', expect: 'Status APPROVED.' },
    { who: 'CREDIT OFFICER', where: 'Application > quotation (PASQ)', action: 'Issue Quotation.', expect: 'Pre-agreement statement and quotation issued; waiting for the consumer.' },
    { who: 'CLIENT', where: 'Portal > Applications > the application', action: 'Open the quotation and confirm receipt.', expect: 'Staff side shows "Consumer acknowledgement on record".' },
    { who: 'CREDIT OFFICER', where: 'Application > Agreement', action: 'Generate the credit agreement. From here to payout, finish on the SAME day: a debit-order agreement is only current on the day it was generated.', expect: 'Agreement generated and awaiting signature.' },
    { who: 'CLIENT', where: 'Portal > Agreement', action: 'Read the signing packet (PASQ first, agreement second), sign, then I Accept and Sign Digitally.', expect: 'Agreement signed by the consumer.' },
    { who: 'ADMIN', where: 'Application > Agreement', action: 'Countersign Agreement.', expect: 'Executed agreement stored.' },
    { who: 'CLIENT', where: 'Portal > Mandate', action: `Confirm the banking details (${p.bank.bankCode} ${p.bank.accountNumber}) and sign the debit order mandate.`, expect: 'Mandate signed.' },
    { who: 'ADMIN', where: 'Application > Disburse', action: 'Tick "I confirm the disbursement details are correct", then Disburse Loan.', expect: `Loan booked and DISBURSED: ${loanTerms(p)}.` },
  ]
}

function newClientCapture(p: Persona, declined: boolean): Step[] {
  const purpose = purposeOf(p)
  return [
    { who: 'CREDIT OFFICER', where: 'Staff app > Clients > New client', action: 'Capture every detail in "Details to type" (expenses, debts, bank, next of kin), tick POPIA consent, save.', expect: 'Client created with a reference number.' },
    { who: 'CREDIT OFFICER', where: 'Applications > New application', action: `Choose ${p.firstName} ${p.lastName}; ${loanTerms(p)}; purpose "${purpose.category}" / "${purpose.text}". ` + (declined ? 'The affordability step shows FAIL: tick the reckless-lending acknowledgement to proceed. ' : '') + 'Submit for review.', expect: 'Application SUBMITTED.' },
    { who: 'CLIENT', where: 'Portal > Register', action: 'Enter the persona email and SA ID number, request the 6-digit activation code, enter it and set a portal password; sign in.', expect: 'Portal dashboard shows the application. (See README: activation code.)' },
  ]
}

export function stepsFor(p: Persona): Step[] {
  switch (p.storyline) {
    case 'live-clean-approve':
      return [...newClientCapture(p, false), ...documentsAndSelfie(p), ...reviewAndAffordability(), ...approveToPayout(p)]
    case 'live-affordability-decline':
      return [
        ...newClientCapture(p, true),
        ...documentsAndSelfie(p),
        ...reviewAndAffordability(),
        { who: 'ADMIN', where: 'Application > decision panel', action: 'Repayment method Debit order, then Approve.', expect: `Refused by the product, not by the presenter. Message shown: "${RECORDED_DECLINE_REASON}" (figures in cents: NDI ${R(180913)} against ${R(283861)} required). Affordability shows NOT AFFORDABLE.` },
        { who: 'ADMIN', where: 'Application > decision panel', action: `Decline, category Affordability, reason "${DECLINE_TEXT}", Confirm Decline.`, expect: 'Status DECLINED. Story ends here.' },
      ]
    case 'live-returning-client':
      return [
        { who: 'CREDIT OFFICER', where: `Staff app > Clients > search "${p.lastName}"`, action: 'Open the client: Loans tab shows the first loan COMPLETED (settled early); nothing open.', expect: 'An existing client with a clean repayment history.' },
        { who: 'CLIENT', where: 'Portal > sign in', action: 'Sign in with the persona email (portal already active from the first loan).', expect: 'Portal dashboard with the settled loan.' },
        { who: 'CLIENT', where: 'Portal > Apply > Personal Loan', action: `"Applying as" shows the details on file. ${loanTerms(p)}; purpose "${purposeOf(p).category}" / "${purposeOf(p).text}"; tick the declarations; submit. Fallback if the portal refuses: CREDIT OFFICER > Applications > New application for the existing client.`, expect: 'Application SUBMITTED as an existing client; no re-capture.' },
        ...documentsAndSelfie(p),
        ...reviewAndAffordability(),
        ...approveToPayout(p),
      ]
    default:
      throw new Error(`${p.id}: no live-demo story for storyline ${p.storyline}`)
  }
}

export const SELFIE_SCRIPT =
  'This is a live face match. The vision model that just read the payslips now compares this selfie with the photograph ' +
  'printed on the ID card, and checks it is a live person, not a photo of a photo. The specimen card carries my photo so ' +
  'the match is genuine; for a real applicant it is their own ID. If it cannot confirm the match, the attempt fails and the ' +
  'client retakes it, or staff record an in-person verification instead. Every attempt is kept as KYC evidence.'
