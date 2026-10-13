/**
 * recomputeApplicationFlags against a migrated database and a real statement
 * PDF on disk: the read is persisted once, flags are raised, a recompute is
 * idempotent, a cleared flag stays cleared, and flags whose evidence is gone
 * are superseded.
 *
 *   RUN_CREDIT_CHECKS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/credit-checks/recompute.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { syntheticStatement } from "@/lib/statement-analysis/fixtures/dataset"
import { buildCapitecStatement } from "@/lib/statement-analysis/fixtures/synthetic"
import { recomputeApplicationFlags } from "./recompute"

const RUN = process.env.RUN_CREDIT_CHECKS_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("recomputeApplicationFlags against Postgres", () => {
  const tenantId = `tenant_recompute_${token}`
  const clientId = `client_recompute_${token}`
  const appId = `app_recompute_${token}`
  const userId = `user_recompute_${token}`
  const docId = `doc_recompute_${token}`
  const dir = mkdtempSync(join(tmpdir(), "cf-checks-it-"))
  const openCodes = async () =>
    (await prisma.applicationCheckFlag.findMany({ where: { tenantId, applicationId: appId, status: "OPEN" } }))
      .map((f) => f.code).sort()

  beforeAll(async () => {
    const statement = syntheticStatement({ bank: "CAPITEC", start: "2026-07-01", undisclosedLoan: true, gambling: true, paydayLender: true, returnedDebit: true })
    const pdf = Buffer.from(await buildCapitecStatement(statement))
    const storagePath = join(dir, "statement.pdf")
    writeFileSync(storagePath, pdf)

    await prisma.tenant.create({ data: { id: tenantId, slug: `recompute-${token}`, name: "Recompute test" } })
    await prisma.user.create({ data: { id: userId, tenantId, email: `officer-${token}@test.invalid`, password: "x", role: "LOAN_ADMIN" } })
    await prisma.client.create({
      data: {
        id: clientId, tenantId, reference: `CLI-${token}`, idNumber: `ID-${token}`, firstName: "Thabo", lastName: "Tester",
        email: `client-${token}@test.invalid`, phone: "+27820000000", monthlyIncome: 1_845_000,
      },
    })
    await prisma.loanProduct.create({
      data: { id: `product_${token}`, tenantId, code: `RC-${token}`, name: "Recompute product", productType: "PERSONAL", minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL" },
    })
    await prisma.loanApplication.create({
      data: { id: appId, tenantId, reference: `APP-${token}`, clientId, productId: `product_${token}`, appliedAmount: 500_000, appliedTermDays: 30, status: "UNDER_REVIEW", submittedAt: new Date("2026-10-05T08:00:00Z") },
    })
    await prisma.clientDocument.create({
      data: {
        id: docId, tenantId, clientId, docType: "BANK_STATEMENT", fileUrl: "", fileName: "statement.pdf",
        mimeType: "application/pdf", storagePath, contentSha256: sha256DocumentBytes(pdf), extractionStatus: "done",
      },
    })
  })

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId } })
    await prisma.applicationCheckFlag.deleteMany({ where: { tenantId } })
    await prisma.statementAnalysis.deleteMany({ where: { tenantId } })
    await prisma.clientDocument.deleteMany({ where: { tenantId } })
    await prisma.loanApplication.deleteMany({ where: { tenantId } })
    await prisma.loanProduct.deleteMany({ where: { tenantId } })
    await prisma.client.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads the statement once, persists the read, and raises its flags", async () => {
    const result = await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(result?.recomputed).toBe(true)
    expect(await openCodes()).toEqual(["GAMBLING", "PAYDAY_LENDER", "RETURNED_DEBIT", "UNDISCLOSED_DEBIT_ORDER"])

    const reads = await prisma.statementAnalysis.findMany({ where: { tenantId, clientDocumentId: docId } })
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ method: "TEXT", status: "READ", bank: "CAPITEC", balanceCheck: "PASS", accountNumberLast4: "0001" })
    expect(Number(reads[0].openingBalanceCents)).toBe(234_567)

    const flag = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { tenantId, applicationId: appId, code: "UNDISCLOSED_DEBIT_ORDER" } })
    expect(flag.evidence).toMatchObject({ documentId: docId, analysisId: reads[0].id, counterparty: "SYNTHLEND FINANCE", occurrences: 3 })
    expect(await prisma.auditLog.count({ where: { tenantId, action: "CREDIT_CHECKS_RECOMPUTED", entityId: appId } })).toBe(1)
  })

  it("is idempotent: a second recompute changes no row and writes no audit", async () => {
    const before = await prisma.applicationCheckFlag.findMany({ where: { tenantId }, orderBy: { id: "asc" } })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    const after = await prisma.applicationCheckFlag.findMany({ where: { tenantId }, orderBy: { id: "asc" } })
    expect(after.map((f) => [f.id, f.status, f.fingerprint])).toEqual(before.map((f) => [f.id, f.status, f.fingerprint]))
    expect(await prisma.statementAnalysis.count({ where: { tenantId } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { tenantId, action: "CREDIT_CHECKS_RECOMPUTED" } })).toBe(1)
  })

  it("keeps a cleared flag cleared, and supersedes open flags whose statement is gone", async () => {
    const gambling = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { tenantId, applicationId: appId, code: "GAMBLING" } })
    await prisma.applicationCheckFlag.update({
      where: { id: gambling.id, tenantId },
      data: { status: "CLEARED", clearedById: userId, clearedAt: new Date(), clearReason: "Occasional bets, well inside budget." },
    })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect((await prisma.applicationCheckFlag.findFirstOrThrow({ where: { id: gambling.id, tenantId } })).status).toBe("CLEARED")

    await prisma.clientDocument.update({ where: { id: docId, tenantId }, data: { deletedAt: new Date() } })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(await openCodes()).toEqual(["NO_STATEMENT"])
    const statuses = await prisma.applicationCheckFlag.groupBy({ by: ["status"], where: { tenantId }, _count: true })
    expect(Object.fromEntries(statuses.map((s) => [s.status, s._count]))).toEqual({ OPEN: 1, CLEARED: 1, SUPERSEDED: 3 })
  })

  it("does not recompute a decided application", async () => {
    await prisma.loanApplication.update({ where: { id: appId, tenantId }, data: { status: "DECLINED", decisionReason: "Test" } })
    await prisma.clientDocument.update({ where: { id: docId, tenantId }, data: { deletedAt: null } })
    const result = await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(result?.recomputed).toBe(false)
    expect(await openCodes()).toEqual(["NO_STATEMENT"])
  })
})
