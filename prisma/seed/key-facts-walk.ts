/**
 * What makes a Lesotho demo walkable from a fresh seed with no database surgery (DEMO_LENDER=basotho): an approval matrix
 * whose rule matches an ungraded application, two borrowers with verified evidence (one to apply in the portal, one already
 * approved) and DPD brought current, so the demo loan shows its arrears. Everything goes through the code the app runs:
 * the maker-checker service, the real decide function, the DPD job. Synthetic files, on a demo database only.
 *
 * The approved application stays payable on the day it was approved (docs/non-nca-go-live.md): a later walk returns it to
 * review and approves it again, from the application page.
 */
import { randomBytes, createHash } from "node:crypto"
import { prisma } from "../../lib/prisma"
import { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "../../lib/affordability/snapshot"
import { MATRIX_KIND, type MatrixPayload } from "../../lib/approval/types"
import { recomputeApplicationFlags } from "../../lib/credit-checks/recompute"
import { sastCalendarDate } from "../../lib/date/sast"
import { ensureActiveJurisdiction } from "../../lib/jurisdiction/load.server"
import { updateTenantDpd } from "../../lib/loan/dpd-update"
import { approve, createDraft, submit } from "../../lib/maker-checker/service"
import { saveFile } from "../../lib/storage"
import { runWithTenant } from "../../lib/tenant-scope"
import { decideApplication } from "../../app/api/applications/[id]/decide/decide-application"

interface Staff { id: string; email: string; role: string }

const LONG_AGO = new Date(Date.now() - 2 * 365 * 86_400_000)
const EXPENSES = { housing: 900_000, transport: 300_000, food: 500_000, insurance: 100_000, medical: 100_000 }
const WALK_REFERENCE = "APP-SEED-0005"
const TERMS = { appliedAmount: 150_000, appliedTermDays: 30 }

const matrix = (today: string): MatrixPayload => ({
  name: "Demo key-facts matrix", enabled: true, effectiveFrom: today, defaultRequiredLevels: 1,
  levels: [{ level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false }],
  // A key-facts application has no risk grade: a riskGradeRankMin rule would never match it.
  rules: [{ id: "key-facts-ungraded", name: "Key-facts applications (no risk grade)", when: { ungraded: true }, requiredLevels: 1 }],
})

async function seedMatrix(tenantId: string, maker: Staff, checker: Staff) {
  if (await prisma.approvalMatrixVersion.findFirst({ where: { tenantId } })) return
  const asActor = (s: Staff) => ({ ...s, role: s.role as never, totpVerified: true })
  const draft = await createDraft({ tenantId, actor: asActor(maker), kind: MATRIX_KIND, title: "Demo key-facts matrix", payload: matrix(sastCalendarDate(new Date())) })
  await submit({ tenantId, actor: asActor(maker), id: draft.id })
  await approve({ tenantId, actor: asActor(checker), id: draft.id, note: "Synthetic demo matrix." })
}

/** The four core documents, verified long ago, and a statement whose stored bytes match the digest the payout gate re-reads. */
async function seedEvidence(tenantId: string, clientId: string, officerId: string) {
  if (await prisma.clientDocument.findFirst({ where: { tenantId, clientId, docType: "BANK_STATEMENT" } })) return
  const client = await prisma.client.update({
    where: { id: clientId },
    data: { grossMonthlyIncome: 5_000_000, monthlyIncome: 4_500_000, monthlyExpenses: 1_900_000, accountType: "CHEQUE", expenseBreakdown: { create: EXPENSES } },
  })
  const bytes = Buffer.from(`%PDF synthetic demo bank statement ${clientId}`)
  const stored = await saveFile(bytes, "application/pdf")
  for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
    const statement = docType === "BANK_STATEMENT"
    await prisma.clientDocument.create({
      data: {
        tenantId, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: statement ? stored.fileSize : 1024, mimeType: "application/pdf",
        contentSha256: statement ? createHash("sha256").update(bytes).digest("hex") : randomBytes(32).toString("hex"), storagePath: statement ? stored.storagePath : undefined,
        extractionStatus: "skipped", verified: true, verifiedAt: LONG_AGO, verifiedById: officerId, createdAt: LONG_AGO, uploadedByType: "staff",
        ...(statement ? { extractionResult: { fields: { accountNumber: client.bankAccountNumber, bankName: client.bankName, accountType: "CHEQUE" } } } : {}),
      },
    })
  }
}

async function seedApprovedApplication(tenantId: string, args: { clientId: string; productId: string; officer: Staff; approver: Staff }) {
  const { clientId, productId, officer, approver } = args
  if (await prisma.loanApplication.findFirst({ where: { tenantId, reference: WALK_REFERENCE } })) return
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, include: { expenseBreakdown: true } })
  const product = await prisma.loanProduct.findUniqueOrThrow({ where: { id: productId } })
  const submittedAt = new Date(Date.now() - 60 * 60_000)
  const submission = createSubmissionAffordabilitySnapshot({
    capturedAt: submittedAt, capturedById: officer.id, client, applicationDebts: [], clientDebts: [],
    application: { ...TERMS, productId, initiationFeePayment: "DEFERRED" }, product,
  })
  const application = await prisma.loanApplication.create({
    data: {
      tenantId, reference: WALK_REFERENCE, clientId, productId, ...TERMS, purpose: "School fees", initiationFeePayment: "DEFERRED", status: "UNDER_REVIEW",
      submittedAt, assignedToId: officer.id, existingDebtObligations: [], affordabilityResult: withAffordabilitySnapshot(null, submission) as object,
    },
  })
  await recomputeApplicationFlags(tenantId, application.id, { userId: officer.id })
  await prisma.applicationCheckFlag.updateMany({
    where: { tenantId, applicationId: application.id, status: "OPEN" },
    data: { status: "CLEARED", clearedById: officer.id, clearedAt: new Date(), clearReason: "Synthetic demo: income verified by other means." },
  })
  const form = new FormData()
  form.append("action", "approve")
  form.append("repaymentMethod", "EFT")
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
  const res = await decideApplication({ tenant: tenant as never, user: { ...approver, name: "Demo Loan Admin", role: approver.role as never, totpVerified: true } as never, id: application.id, formData: form })
  if (res.status !== 200) throw new Error(`Seed: ${WALK_REFERENCE} was not approved: ${await res.text()}`)
}

export async function seedKeyFactsWalk(tenantId: string, args: {
  maker: Staff; checker: Staff; approver: Staff; officer: Staff; productId: string; borrowers: { approved: string; apply: string }
}) {
  await ensureActiveJurisdiction()
  await runWithTenant(tenantId, async () => {
    await seedMatrix(tenantId, args.maker, args.checker)
    await seedEvidence(tenantId, args.borrowers.approved, args.officer.id)
    await seedEvidence(tenantId, args.borrowers.apply, args.officer.id)
    await seedApprovedApplication(tenantId, { clientId: args.borrowers.approved, productId: args.productId, officer: args.officer, approver: args.approver })
    await updateTenantDpd(tenantId)
  })
}
