/**
 * A borrower who can be approved with no person: core KYC verified, and a recent statement and payslip that the real credit
 * checks read and find nothing in, so no flag waits for an officer to clear it. For key-facts-instant.integration.test.ts. Everything
 * is synthetic. Not a test file.
 */
import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { simulatedScenarioFor } from "@/lib/bureau/providers/simulated"
import { sha256 } from "@/lib/non-nca-documents/ls-stack.integration-fixture"
import type { Stack } from "@/lib/non-nca-documents/ls-stack.integration-fixture"
import { syntheticStatement } from "@/lib/statement-analysis/fixtures/dataset"
import { buildCapitecStatement } from "@/lib/statement-analysis/fixtures/synthetic"

const NET_PAY = 1_845_000
const EXPENSES = { housing: 400_000, transport: 150_000, food: 150_000, insurance: 50_000, medical: 50_000 }

/** A synthetic ID number the simulated bureau answers with its clean report (a pure function of the number). */
export function cleanIdNumber(make: () => string): string {
  for (;;) {
    const id = make()
    if (simulatedScenarioFor(id) === "CLEAN") return id
  }
}

/** The first of the month three months ago: the statement then covers the last three whole months. */
function statementStart(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))
  return d.toISOString().slice(0, 10)
}

export async function seedDigitalBorrower(db: PrismaClient, stack: Stack, clientId: string, opts: { files: Map<string, Buffer>; idNumber: string; lastName?: string; income?: number; bank?: Record<string, string> }) {
  const income = opts.income ?? NET_PAY
  await db.client.create({
    data: {
      id: clientId, tenantId: stack.tenant, reference: `CLI-${clientId}`, idNumber: opts.idNumber, firstName: "Thabo", lastName: opts.lastName ?? "Tester",
      email: `${clientId}@test.invalid`, phone: "+26658000011", dateOfBirth: new Date("1990-05-01T00:00:00Z"), popiaConsentGiven: true,
      grossMonthlyIncome: income + 200_000, monthlyIncome: income, monthlyExpenses: 800_000, expenseBreakdown: { create: EXPENSES },
      ...{ bankName: "Demo Bank Lesotho", bankAccountNumber: "0000000001", bankBranchCode: "100001", ...opts.bank }, accountType: "CHEQUE",
    },
  })
  const account = { bankName: "Demo Bank Lesotho", bankAccountNumber: "0000000001", bankBranchCode: "100001", ...opts.bank }
  const statement = Buffer.from(await buildCapitecStatement(syntheticStatement({ bank: "CAPITEC", start: statementStart(), netPayCents: income })))
  const statementPath = `/mem/statement-${clientId}.pdf`
  opts.files.set(statementPath, statement)
  const payDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 25)).toISOString().slice(0, 10)
  for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
    const isStatement = docType === "BANK_STATEMENT"
    await db.clientDocument.create({
      data: {
        tenantId: stack.tenant, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: 1024, mimeType: "application/pdf",
        contentSha256: isStatement ? sha256(statement) : randomBytes(32).toString("hex"), storagePath: isStatement ? statementPath : undefined,
        extractionStatus: docType === "PAYSLIP" || isStatement ? "done" : "skipped", verified: true, verifiedAt: new Date(), verifiedById: stack.officer, uploadedByType: "staff",
        // What the statement reader would have read off the page: the payout gate matches it to the client's bank record.
        ...(isStatement ? { extractionResult: { fields: { accountNumber: account.bankAccountNumber, bankName: account.bankName, accountType: "CHEQUE" } } } : {}),
        ...(docType === "PAYSLIP" ? { extractionResult: {
          grossIncome: { value: income + 200_000, validated: true }, totalDeductions: { value: 200_000, validated: true }, netIncome: { value: income, validated: true }, payDate: { value: payDate }, employeeName: { value: "Thabo Tester" },
        } } : {}),
      },
    })
  }
}
