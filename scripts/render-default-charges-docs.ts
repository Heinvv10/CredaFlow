/**
 * Renders the default-charges NCA documents (statement, certificate of balance,
 * Section 129 notice) for a fixture loan, with and without charges, for legal
 * review. Charges come from the real engine. Writes PDFs only; convert with
 *   pdftoppm -png -r 72 <file>.pdf <out-dir>/<name>
 *
 *   npx tsx scripts/render-default-charges-docs.ts <out-dir>
 */
import { writeFileSync } from "node:fs"
import { generateStatementPdf } from "@/lib/pdf/statement"
import { generateCertificateOfBalancePdf } from "@/lib/pdf/certificateOfBalance"
import { generateSection129Pdf } from "@/lib/pdf/section129"
import { ACME_LENDER as lender } from "@/lib/config/__fixtures__/lender-identity"

const OUT = process.argv[2]
const client = { firstName: "Synthetic", lastName: "Borrower", idNumber: "9001015009087", email: "fixture@example.invalid", addressLine1: "1 Fixture Street", city: "Johannesburg" }
const d = (s: string) => new Date(`${s}T10:00:00+02:00`)
import { computeDefaultCharges } from "@/lib/loan/default-charges"
import { chargeBreakdownLines, summariseCharges } from "@/lib/loan/charges-summary"
import { currentSettlementAmount } from "@/lib/loan/settlement"
// R2,000 MICRO bullet due 1 Sep; R500 paid 11 Sep; S129 issued 5 Oct; as at 26 Oct.
// Charges come from the real engine, not typed-in numbers.
const replay = computeDefaultCharges({
  schedule: [{ dueDate: d("2026-09-01"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: 216_900 }],
  receipts: [{ id: "p1", amount: 50_000, receivedAt: d("2026-09-11") }],
  adminCharges: [{ id: "s129-fixture", date: d("2026-10-05"), amount: 8_200 }],
  interestRatePm: 0.05, monthlyServiceFee: 6_900, maturityDate: d("2026-09-01"), asOf: d("2026-10-26"),
})
const summary = summariseCharges(replay)
const postings = replay.postings
const chargesOwing = summary.outstanding
const scheduleOwing = 216_900 - replay.scheduleAllocated
const principalOwing = Math.min(200_000, scheduleOwing)
const settle = scheduleOwing + chargesOwing
const loan = {
  id: "fixture", reference: "LN-FIXTURE-0001", principal: 200_000, totalRepayable: 216_900, totalPaid: replay.scheduleAllocated,
  outstandingPrincipal: principalOwing, interestRatePm: 0.05, interestModel: "FLAT" as const, status: "DEFAULTED",
  startDate: d("2026-08-01"), maturityDate: d("2026-09-01"), daysInArrears: 55, arrearsAmount: scheduleOwing,
}
// What the S129 notice and the certificate state while charges are live: the
// amount the receipt paths accept to settle, charges included.
const toSettle = currentSettlementAmount({
  loan: { ...loan, totalInterest: 10_000 },
  schedule: [{ id: "row-1", dueDate: d("2026-09-01"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: 216_900, totalPaid: replay.scheduleAllocated }],
  asOf: d("2026-10-26"), chargesOutstanding: chargesOwing,
})
const payments = [{ createdAt: d("2026-09-11"), receivedAt: d("2026-09-11"), amount: 50_000, paymentMethod: "EFT", reference: "FNB-123", allocationStatus: "ALLOCATED" as const }]
const schedule = [{ installmentNo: 1, dueDate: d("2026-09-01"), totalDue: 216_900, totalPaid: replay.scheduleAllocated, status: "PARTIAL" }]
const cobLoan = { ...loan, lastPaymentDate: d("2026-09-11"), lastPaymentAmount: 50_000 }
// Charges off: the whole R500 went to the schedule.
const legacy = { ...loan, totalPaid: 50_000, outstandingPrincipal: 166_900, arrearsAmount: 166_900 }
const legacySchedule = [{ ...schedule[0], totalPaid: 50_000 }]

async function main() {
  const asAt = d("2026-10-26")
  writeFileSync(`${OUT}/statement-no-charges.pdf`, await generateStatementPdf({ lender, client, loan: legacy, product: { name: "Micro Loan" }, schedule: legacySchedule, payments, statementDate: asAt }))
  // With charges live, the documents state arrears including them (as the callers pass).
  const charged = { ...loan, arrearsAmount: scheduleOwing + chargesOwing }
  writeFileSync(`${OUT}/statement-with-charges.pdf`, await generateStatementPdf({ lender, client, loan: charged, product: { name: "Micro Loan" }, schedule, payments, statementDate: asAt,
    charges: { postings, outstanding: chargesOwing, settlement: settle } }))
  // Charges off: exactly what the callers pass while the tenant flag is off.
  writeFileSync(`${OUT}/cob-no-charges.pdf`, await generateCertificateOfBalancePdf({ lender, client, loan: { ...cobLoan, ...legacy }, asAt }))
  writeFileSync(`${OUT}/cob-with-charges.pdf`, await generateCertificateOfBalancePdf({ lender, client, loan: { ...cobLoan, arrearsAmount: charged.arrearsAmount }, asAt,
    settlement: { paymentsReceived: 50_000, interestAndFeesOutstanding: toSettle - chargesOwing - principalOwing, charges: chargeBreakdownLines(summary), totalToSettle: toSettle } }))
  const s129loan = { reference: loan.reference, arrearsAmount: scheduleOwing, outstandingPrincipal: principalOwing, daysInArrears: 55 }
  writeFileSync(`${OUT}/s129-no-charges.pdf`, await generateSection129Pdf({ lender, client, noticeDate: asAt,
    loan: { ...s129loan, arrearsAmount: legacy.arrearsAmount, outstandingPrincipal: legacy.outstandingPrincipal } }))
  writeFileSync(`${OUT}/s129-with-charges.pdf`, await generateSection129Pdf({ lender, client, noticeDate: asAt,
    loan: { ...s129loan, arrearsAmount: charged.arrearsAmount, totalOutstanding: toSettle, chargesOutstanding: chargesOwing } }))
  process.stdout.write(JSON.stringify({ postings, chargesOwing, scheduleOwing, settle, toSettle }) + "\n")
}
main().then(() => process.exit(0), (error) => { process.stderr.write(String(error)); process.exit(1) })
