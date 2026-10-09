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
  process.stdout.write(JSON.stringify({ s129: sha256(s129), cob: sha256(cob), statement: sha256(statement) }) + "\n")
}

if (process.argv[1]?.endsWith("nca-pdf-fingerprint.ts")) {
  main().then(() => process.exit(0), (error) => { process.stderr.write(String(error)); process.exit(1) })
}
