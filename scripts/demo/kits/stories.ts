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
import type { Persona, PersonaBankCode } from '../personas/types'
import { money } from '../specimens/pdf-kit'

export type Actor = 'CREDIT OFFICER' | 'ADMIN' | 'CLIENT' | 'PRESENTER'

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

const fullName = (p: Persona): string => `${p.firstName} ${p.lastName}`

/**
 * The staff wizard's "Purpose category" option for purposeOf().category
 * (lib/validation/application-wizard.ts LOAN_PURPOSE_OPTIONS); the portal
 * form spells the same categories in sentence case.
 */
const STAFF_PURPOSE_LABEL: Record<string, string> = { 'Debt consolidation': 'Debt Consolidation', Household: 'Household' }

/**
 * The bank names in the portal mandate form (PortalDebitMandateClient BANKS).
 * Client.bankName holds the code, which matches none of them, so the form
 * opens with no bank selected.
 */
const MANDATE_BANK_LABEL: Record<PersonaBankCode, string> = {
  ABSA: 'ABSA Bank', FNB: 'FNB (First National Bank)', NEDBANK: 'Nedbank', STANDARD_BANK: 'Standard Bank', CAPITEC: 'Capitec Bank', TYME_BANK: 'TymeBank',
}

/**
 * Everything below was walked through the real UI in the dress rehearsal of
 * 2026-10-10 (build 0c362f0): button and panel names are the ones on screen.
 */
function documentsAndSelfie(p: Persona, latestPayslip: string): Step[] {
  const files = `id-card.png on ID Copy; ${latestPayslip} on Payslip (one payslip is enough: the row keeps the latest and shows older ones as SUPERSEDED); the bank statement on Bank Statement; the SAME bank statement on Proof of Address (the specimens carry no utility bill; that row accepts a statement)`
  const wait = 'wait for "Analysing your document..." to become "Document scanned" (5 to 15 seconds) before the next'
  const upload: Step = { who: 'CLIENT', where: 'Portal > Documents > Required documents', action: `One file at a time, each on its own row: press Upload, choose the file, press Upload, and ${wait}: ${files}.`, expect: 'Four rows PENDING REVIEW and "Action needed: Selfie verification". What was read off each document shows on the staff KYC tab, not here.' }
  return [
    upload,
    { who: 'CLIENT', where: 'Same page > Selfie verification row > Take selfie', action: 'Open Camera (allow the browser camera prompt), face in the oval, Take Photo, then Upload. See "At the selfie step" below.', expect: `Toast "Selfie uploaded"; within about 20 seconds the row reads "Identity verified at NN% match" and "VERIFIED - NN%" (needs match ${BIOMETRIC_MATCH_THRESHOLD}% and liveness ${BIOMETRIC_LIVENESS_THRESHOLD}% or more). If it could not be verified, press Retake.` },
    { who: 'CREDIT OFFICER', where: `Clients > search "${p.lastName}" > View > KYC tab`, action: 'Each of the four rows shows what was read off the document (ID number, employer and gross pay, bank account, address): compare, then press Verify on each. The selfie card shows Match Score and Liveness and needs no click. Do not press Approve KYC.', expect: 'Toast "Document verified" each time; top card "KYC Status VERIFIED, 4 / 4 verified" (the status beside the client name catches up on refresh).' },
  ]
}

function reviewAndAffordability(p: Persona, affordable: boolean): Step[] {
  return [
    { who: 'CREDIT OFFICER', where: `Applications > ${fullName(p)}'s card`, action: 'Start Review (Decision rail, right-hand side). It is refused while KYC is incomplete.', expect: 'Toast "Review started"; status UNDER REVIEW; a "Credit Bureau Check" panel appears on the page (Experian score; simulated in the demo).' },
    { who: 'CREDIT OFFICER', where: 'Same page > Affordability Assessment', action: 'Check the Existing Credit Obligations rows (pre-filled from the client record), then Update Affordability.', expect: `No message appears; the server recomputes net disposable income (NDI) and the panel shows ${affordable ? 'AFFORDABLE' : 'a negative NDI After Loan and NOT AFFORDABLE'}.` },
  ]
}

function complianceChecks(): Step {
  return { who: 'ADMIN', where: 'Applications > the application > NCA Compliance Checks', action: 'Tick "Reckless lending assessment completed". "Client affordability declaration captured" is already ticked from the application: leave it. Confirm Assessment Checks.', expect: 'The panel shows "Complete" (no toast).' }
}

function approveToPayout(p: Persona): Step[] {
  return [
    { who: 'ADMIN', where: 'Same page > Decision rail', action: 'Repayment method Debit order, then Approve. Leave the Initiation Fee Election panel at its default.', expect: 'Status APPROVED; a "Credit Agreement" panel appears.' },
    { who: 'CREDIT OFFICER', where: 'Refresh the application > Credit Agreement panel', action: 'Prepare PASQ + Credit Agreement: one button issues the quotation (PASQ) and generates the agreement. View PASQ + Agreement opens the packet. From here to payout, finish on the SAME day: a debit-order agreement is only current on the day it was generated.', expect: 'Toast "Agreement generated"; "Agreement generated and awaiting signature".' },
    { who: 'CLIENT', where: 'Portal > Applications > Sign Now', action: 'Tick the five declarations (the first acknowledges the PASQ), draw the signature with the mouse (or Type it), then I Accept and Sign Digitally. Known issue on build 0c362f0: the packet frame on this page shows {"error":"Not found"} instead of the PDF, so show the packet from the staff app in the previous step.', expect: '"Agreement signed", with a Set up repayment button.' },
    { who: 'ADMIN', where: 'Refresh the application > Credit Agreement panel', action: 'Tick "I have reviewed the exact consumer-signed agreement..." (the signature box is pre-filled), then Countersign Agreement.', expect: 'Toast "Provider countersignature recorded"; the rail now waits for the debit mandate.' },
    { who: 'CLIENT', where: 'Portal > Set up repayment (on the "Agreement signed" page, or Overview > Set Up Repayment)', action: `Choose the bank "${MANDATE_BANK_LABEL[p.bank.bankCode]}" (it is not pre-selected); account ${p.bank.accountNumber} and branch ${p.bank.branchCode} are filled in. Prepare mandate, tick the three boxes, draw the signature, Authorise and sign mandate.`, expect: '"Debit mandate signed".' },
    { who: 'ADMIN', where: 'Refresh the application > Disburse Loan', action: 'The button opens the payout form: tick "I confirm the disbursement details are correct", then press the Confirm - Disburse button.', expect: `Status DISBURSED, "Active loan created": ${loanTerms(p)}. The borrower sees it under Portal > Loans.` },
  ]
}

function newClientCapture(p: Persona, declined: boolean): Step[] {
  const purpose = purposeOf(p)
  return [
    { who: 'CREDIT OFFICER', where: 'Staff app > Clients > + New Client', action: 'Four wizard steps (Identity, Address, Employment & income, Review). Type "Details to type"; date of birth and gender fill in from the ID number; press + Add debt once per debt. On Review tick the POPIA consent box, then Create client.', expect: `Toast "Client created"; the Clients list opens with ${fullName(p)} at the top, KYC Pending.` },
    { who: 'CREDIT OFFICER', where: 'Applications > New Application', action: `Search "${p.lastName}" and pick ${fullName(p)} (check the first name: the surname is not unique), Next. Personal Loan, amount ${p.loanRequest.amountCents / 100}, term ${p.loanRequest.termDays}; Purpose category "${STAFF_PURPOSE_LABEL[purpose.category] ?? purpose.category}", Purpose "${purpose.text}"; Next. ` + (declined ? 'Affordability shows FAIL: tick the reckless-lending acknowledgement, Next. ' : 'Affordability shows PASS: Next. ') + 'On Review tick the two declarations, then Submit for review.', expect: 'Toast "Application submitted for review"; the card sits under SUBMITTED on the Applications board.' },
    { who: 'CLIENT', where: 'Portal sign-in page > Create your account', action: 'Enter the persona email and SA ID number, Send activation code. The page then shows the 6-digit activation code ("Demo environment: your code is ...", see README): type it in, set a portal password twice, Activate account. You are returned to the sign-in page: sign in.', expect: '"My Applications" shows the application as Submitted.' },
  ]
}

/**
 * The returning client is not asked to re-capture: her first-loan documents
 * and in-person identity check still stand and Start Review is not blocked.
 * Re-uploading would only list SUPERSEDED rows, so the story skips it.
 */
const RETURNING_DOCUMENTS_NOTE: Step = {
  who: 'PRESENTER',
  where: 'Portal > Documents',
  action: 'Say: "Returning clients aren\'t asked to re-capture: the page says all required documents are complete and no selfie is needed." Point at the four VERIFIED rows and that message. Upload nothing and take no selfie; the staff KYC step is skipped too.',
  expect: 'The page reads "All required documents are complete ... no selfie is needed".',
}

/** `latestPayslip` is the file name of the newest payslip in the kit folder. */
export function stepsFor(p: Persona, latestPayslip: string): Step[] {
  switch (p.storyline) {
    case 'live-clean-approve':
      return [...newClientCapture(p, false), ...documentsAndSelfie(p, latestPayslip), ...reviewAndAffordability(p, true), complianceChecks(), ...approveToPayout(p)]
    case 'live-affordability-decline':
      return [
        ...newClientCapture(p, true),
        ...documentsAndSelfie(p, latestPayslip),
        ...reviewAndAffordability(p, false),
        { who: 'ADMIN', where: 'Applications > the application > Decision rail', action: 'NCA Compliance Checks already shows "Complete" (recorded with the reckless-lending acknowledgement in the wizard): nothing to tick. Repayment method Debit order, then Approve.', expect: `Refused by the product, not by the presenter. Red toast and a line in the rail: "${RECORDED_DECLINE_REASON}" (figures in cents: NDI ${R(180913)} against ${R(283861)} required). The status stays UNDER REVIEW.` },
        { who: 'ADMIN', where: 'Same page > Decision rail', action: `Decline, Decline category "Affordability", reason "${DECLINE_TEXT}", Confirm Decline.`, expect: 'Status DECLINED, "Application Declined". The borrower sees Declined and the reason under Portal > Applications. Story ends here.' },
      ]
    case 'live-returning-client':
      return [
        { who: 'CREDIT OFFICER', where: `Staff app > Clients > search "${p.lastName}" > View`, action: 'Loans tab: the first loan is COMPLETED with R 0.00 outstanding (settled early). KYC tab: 4 / 4 verified, identity "VERIFIED IN PERSON".', expect: 'An existing client with a clean repayment history.' },
        { who: 'CLIENT', where: 'Portal sign-in page', action: 'Sign in with the persona email (portal already active from the first loan).', expect: 'Overview shows the settled loan: account status "Paid Up", outstanding balance R 0.00.' },
        { who: 'CLIENT', where: 'Portal > Apply > Apply for Personal Loan', action: `"APPLYING AS" shows the details on file. Replace the pre-filled maximums with amount ${p.loanRequest.amountCents / 100} and term ${p.loanRequest.termDays}; category "${purposeOf(p).category}"; purpose "${purposeOf(p).text}"; tick both boxes; Submit application. Fallback if the portal refuses: CREDIT OFFICER > Applications > New Application for the existing client.`, expect: 'The application page opens with status Submitted; no re-capture.' },
        RETURNING_DOCUMENTS_NOTE,
        ...reviewAndAffordability(p, true),
        complianceChecks(),
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
