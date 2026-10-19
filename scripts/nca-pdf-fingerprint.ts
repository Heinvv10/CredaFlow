/**
 * SHA-256 of the Section 129 notice, certificate of balance and statement rendered for a
 * fixed loan at a fixed clock, as they render with default charges OFF, for
 * the neutral Acme demo lender (lib/config/__fixtures__/lender-identity.ts).
 * lib/pdf/charges-off-identity.test.ts pins these hashes; reproduce them by
 * running this script against a checkout of the commit that pinned them:
 *
 *   git archive <commit> lib public scripts tsconfig.json | tar -x -C <dir>
 *   ln -s "$PWD/node_modules" <dir>/node_modules
 *   (cd <dir> && npx tsx scripts/nca-pdf-fingerprint.ts "$PWD")
 */
import { createHash } from "node:crypto"
import { join } from "node:path"
import { ACME_LENDER } from "../lib/config/__fixtures__/lender-identity"

export const FINGERPRINT_CLOCK = Date.parse("2026-09-26T08:00:00.000Z")

export const fingerprintInput = {
  lender: ACME_LENDER,
  client: { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080", addressLine1: "1 Fixture Street", city: "Johannesburg" },
  s129Loan: { reference: "LN-FIXTURE-0001", arrearsAmount: 166_900, outstandingPrincipal: 166_900, daysInArrears: 25 },
  cobLoan: {
    reference: "LN-FIXTURE-0001", startDate: new Date("2026-08-01T08:00:00.000Z"),
    maturityDate: new Date("2026-09-01T08:00:00.000Z"), principal: 200_000, totalRepayable: 216_900,
    totalPaid: 50_000, outstandingPrincipal: 166_900, arrearsAmount: 166_900, daysInArrears: 25,
    interestRatePm: 0.05, lastPaymentDate: new Date("2026-09-11T08:00:00.000Z"), lastPaymentAmount: 50_000,
  },
  asAt: new Date("2026-09-26T08:00:00.000Z"),
  statementLoan: {
    id: "fixture", reference: "LN-FIXTURE-0001", principal: 200_000, totalRepayable: 216_900, totalPaid: 50_000,
    outstandingPrincipal: 166_900, interestRatePm: 0.05, interestModel: "FLAT", status: "DEFAULTED",
    startDate: new Date("2026-08-01T08:00:00.000Z"), maturityDate: new Date("2026-09-01T08:00:00.000Z"),
    daysInArrears: 25, arrearsAmount: 166_900,
  },
  statementSchedule: [{ installmentNo: 1, dueDate: new Date("2026-09-01T08:00:00.000Z"), totalDue: 216_900, totalPaid: 50_000, status: "PARTIAL" }],
  statementPayments: [{ createdAt: new Date("2026-09-11T08:00:00.000Z"), receivedAt: new Date("2026-09-11T08:00:00.000Z"), amount: 50_000, paymentMethod: "EFT", reference: "FNB-123", allocationStatus: "ALLOCATED" as const }],
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// Schedule-length boundaries, pinned in lib/pdf/schedule-continuation.test.ts:
// the longest tables that fitted one page before continuation pages existed
// (38 agreement rows, 37 statement schedule rows, 38 payment-history rows).
export const boundaryStartDate = new Date("2026-07-22T08:00:00.000Z")

/** calculateLoan input for an `instalments`-month reducing-balance loan. */
export const boundaryLoanInput = (instalments: number) => ({
  principal: 10_000_000, termDays: instalments * 30, interestRatePm: 0.03,
  interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.165,
  initiationFeeMax: 108_000, monthlyServiceFee: 6900, productType: "MICRO", initiationFeePayment: "DEFERRED" as const,
})

/** generateCreditAgreementPdf input for a calc from boundaryLoanInput. */
export function boundaryAgreementInput<C extends { schedule: Array<{ dueDate: Date }> }>(variant: "pasq" | "agreement", calc: C) {
  return {
    variant, lender: fingerprintInput.lender, calc,
    client: { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000080", addressLine1: "1 Fixture Street", city: "Johannesburg" },
    application: { reference: "APP-FIXTURE-0001", agreementType: "Personal Loan", appliedTermDays: calc.schedule.length * 30 },
    product: { interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 6900 },
    startDate: boundaryStartDate, maturityDate: calc.schedule[calc.schedule.length - 1].dueDate,
    quotePresentedAt: boundaryStartDate, quoteValidUntilDate: "2026-07-29",
    initiationFeePayment: "DEFERRED" as const, ceremonyMarker: "0123456789ab",
  }
}

/**
 * A quotation/agreement whose long address and offered credit life move the
 * important notices off page 1, so the schedule starts under them on page 2.
 */
export function noticesMovedAgreementInput<C extends { schedule: Array<{ dueDate: Date }> }>(variant: "pasq" | "agreement", calc: C) {
  const base = boundaryAgreementInput(variant, calc)
  return {
    ...base,
    client: {
      ...base.client,
      addressLine1: "Unit 14B Mocker Park Retirement Village, 227 Fixture Main Drive",
      suburb: "Testcliffe Extension 4", province: "Gauteng", postalCode: "2195",
    },
    creditLife: { elected: false, productName: "Fixture Credit Life", insurerName: "Fixture Life", monthlyPremiumCents: 2_250 },
  }
}

/** generateStatementPdf input with `rows` schedule rows and `paid` payments. */
export function boundaryStatementInput(rows: number, paid: number) {
  const month = (i: number) => new Date(Date.UTC(2026, 7 + i, 1, 8))
  const schedule = Array.from({ length: rows }, (_, i) => ({
    installmentNo: i + 1, dueDate: month(i), totalDue: 350_000,
    totalPaid: i < paid ? 350_000 : 0, status: i < paid ? "PAID" : "PENDING",
  }))
  const payments = Array.from({ length: paid }, (_, i) => ({
    createdAt: month(i), receivedAt: month(i), amount: 350_000 + i, paymentMethod: "EFT",
    reference: `FNB-${1000 + i}`, allocationStatus: "ALLOCATED" as const,
  }))
  return {
    lender: fingerprintInput.lender, client: { ...fingerprintInput.client, email: "fixture@example.invalid" },
    loan: { ...fingerprintInput.statementLoan, principal: 10_000_000, totalRepayable: rows * 350_000, status: "ACTIVE", daysInArrears: 0, arrearsAmount: 0 },
    product: { name: "Personal Loan" }, schedule, payments, statementDate: fingerprintInput.asAt,
  }
}

/** Statements whose history carries charge rows, reversed-payment notes and
 *  "of which … default charges" lines, each still fitting on three pages. */
export function variantStatementInputs() {
  const types = ["DEFAULT_INTEREST", "SERVICE_FEE", "DEFAULT_ADMIN"] as const
  const postings = Array.from({ length: 30 }, (_, i) => ({
    type: types[i % 3], day: new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10), amount: 1_000 + i * 10,
  }))
  const charged = boundaryStatementInput(3, 5)
  const reversed = boundaryStatementInput(3, 30)
  const ofWhich = boundaryStatementInput(3, 20)
  return {
    statementCharges: { ...charged, charges: { postings, outstanding: 25_000, settlement: 900_000 } },
    statementReversed: {
      ...reversed,
      payments: reversed.payments.map((p, i) => (i < 8
        ? { ...p, reversed: true, reversedAt: new Date(Date.UTC(2029, 0, 10 + i, 8)), reversalReason: `Bank recall ${i}` }
        : p)),
    },
    statementOfWhich: {
      ...ofWhich,
      payments: ofWhich.payments.map((p) => ({ ...p, defaultInterestAllocated: 1_000, chargeFeesAllocated: 500 })),
    },
  }
}

async function main() {
  const root = process.argv[2]
  const RealDate = Date
  // pdf-lib stamps creation and modification dates from the clock.
  globalThis.Date = class extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...((args.length ? args : [FINGERPRINT_CLOCK]) as [number]))
    }
    static now() { return FINGERPRINT_CLOCK }
  } as DateConstructor
  const { generateSection129Pdf } = await import(join(root, "lib/pdf/section129.ts"))
  const { generateCertificateOfBalancePdf } = await import(join(root, "lib/pdf/certificateOfBalance.ts"))
  const { generateStatementPdf } = await import(join(root, "lib/pdf/statement.ts"))
  const { lender, client, s129Loan, cobLoan, asAt, statementLoan, statementSchedule, statementPayments } = fingerprintInput
  const s129 = await generateSection129Pdf({ lender, client, loan: s129Loan, noticeDate: asAt })
  const cob = await generateCertificateOfBalancePdf({ lender, client, loan: cobLoan, asAt })
  const statement = await generateStatementPdf({
    lender, client: { ...client, email: "fixture@example.invalid" }, loan: statementLoan, product: { name: "Micro Loan" },
    schedule: statementSchedule, payments: statementPayments, statementDate: asAt,
  })
  const { calculateLoan } = await import(join(root, "lib/loan-calculator.ts"))
  const { generateCreditAgreementPdf } = await import(join(root, "lib/pdf/creditAgreement.ts"))
  const calc38 = calculateLoan(boundaryLoanInput(38), boundaryStartDate)
  const agreement38 = await generateCreditAgreementPdf(boundaryAgreementInput("agreement", calc38))
  const pasq38 = await generateCreditAgreementPdf(boundaryAgreementInput("pasq", calc38))
  const statement37 = await generateStatementPdf(boundaryStatementInput(37, 38))
  const variants = variantStatementInputs()
  const noticesMoved: Record<string, string> = {}
  for (const rows of [12, 60]) {
    const calc = calculateLoan(boundaryLoanInput(rows), boundaryStartDate)
    for (const variant of ["pasq", "agreement"] as const) {
      noticesMoved[`${variant}${rows}`] = sha256(await generateCreditAgreementPdf(noticesMovedAgreementInput(variant, calc)))
    }
  }
  const statementCharges = await generateStatementPdf(variants.statementCharges)
  const statementReversed = await generateStatementPdf(variants.statementReversed)
  const statementOfWhich = await generateStatementPdf(variants.statementOfWhich)
  process.stdout.write(JSON.stringify({
    s129: sha256(s129), cob: sha256(cob), statement: sha256(statement),
    agreement38: sha256(agreement38), pasq38: sha256(pasq38), statement37: sha256(statement37),
    statementCharges: sha256(statementCharges), statementReversed: sha256(statementReversed),
    statementOfWhich: sha256(statementOfWhich), noticesMoved,
  }) + "\n")
}

if (process.argv[1]?.endsWith("nca-pdf-fingerprint.ts")) {
  main().then(() => process.exit(0), (error) => { process.stderr.write(String(error)); process.exit(1) })
}
