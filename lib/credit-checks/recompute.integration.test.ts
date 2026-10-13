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
import { recomputeApplicationFlags, recomputeClientApplications } from "./recompute"

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
    // Flags are records the database refuses to delete; the test's own rows go with its guard lifted.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" DISABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
      prisma.$executeRawUnsafe(`DELETE FROM "ApplicationCheckFlag" WHERE "tenantId" = '${tenantId}'`),
      prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" ENABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
    ])
    await prisma.statementAnalysis.deleteMany({ where: { tenantId } })
    await prisma.clientDocument.deleteMany({ where: { tenantId } })
    await prisma.loanApplication.deleteMany({ where: { tenantId } })
    await prisma.existingDebtObligation.deleteMany({ where: { clientId } })
    await prisma.loanProduct.deleteMany({ where: { tenantId } })
    await prisma.client.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads the statement once, persists the read, and raises its flags", async () => {
    const result = await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(result?.recomputed).toBe(true)
    expect(await openCodes()).toEqual(["GAMBLING", "NO_PAYSLIP", "PAYDAY_LENDER", "RETURNED_DEBIT", "UNDISCLOSED_DEBIT_ORDER"])

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
    expect(after.map((f) => [f.id, f.status, f.fingerprint, f.updatedAt.getTime()])).toEqual(before.map((f) => [f.id, f.status, f.fingerprint, f.updatedAt.getTime()]))
    expect(await prisma.statementAnalysis.count({ where: { tenantId } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { tenantId, action: "CREDIT_CHECKS_RECOMPUTED" } })).toBe(1)
  })

  it("keeps a cleared flag cleared through every later recompute", async () => {
    const gambling = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { tenantId, applicationId: appId, code: "GAMBLING" } })
    await prisma.applicationCheckFlag.update({
      where: { id: gambling.id, tenantId },
      data: { status: "CLEARED", clearedById: userId, clearedAt: new Date(), clearReason: "Occasional bets, well inside budget." },
    })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect((await prisma.applicationCheckFlag.findFirstOrThrow({ where: { id: gambling.id, tenantId } })).status).toBe("CLEARED")
  })

  it("does not let an edited client record make an open flag disappear", async () => {
    // Declaring the debt the statement shows makes the finding stop being
    // raised; only an officer may close it.
    await prisma.existingDebtObligation.create({
      data: { clientId, creditProvider: "Synthlend Finance", accountType: "PERSONAL_LOAN", outstandingBalance: 1_000_000, monthlyInstalment: 125_000 },
    })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(await openCodes()).toContain("UNDISCLOSED_DEBIT_ORDER")
  })

  it("does not let a deleted statement make its open flags disappear, and says a statement is missing", async () => {
    await prisma.clientDocument.update({ where: { id: docId, tenantId }, data: { deletedAt: new Date() } })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    // NO_PAYSLIP is only asked of an application with statements; it is about absent evidence, so it may go.
    // And says that a statement it had read is gone.
    expect(await openCodes()).toEqual(["NO_STATEMENT", "PAYDAY_LENDER", "RETURNED_DEBIT", "STATEMENT_DELETED", "UNDISCLOSED_DEBIT_ORDER"])
  })

  it("supersedes a missing-evidence flag when the evidence returns, and reopens one raised again", async () => {
    const noPayslip = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { tenantId, applicationId: appId, code: "NO_PAYSLIP" } })
    expect(noPayslip.status).toBe("SUPERSEDED")
    await prisma.clientDocument.update({ where: { id: docId, tenantId }, data: { deletedAt: null } })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    // STATEMENT_DELETED stays for an officer: the restored file may not be what was read.
    expect(await openCodes()).toEqual(["NO_PAYSLIP", "PAYDAY_LENDER", "RETURNED_DEBIT", "STATEMENT_DELETED", "UNDISCLOSED_DEBIT_ORDER"])
    const reopened = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { id: noPayslip.id, tenantId } })
    expect(reopened).toMatchObject({ status: "OPEN", clearedById: null, clearReason: null })
    expect((await prisma.applicationCheckFlag.findFirstOrThrow({ where: { tenantId, applicationId: appId, code: "NO_STATEMENT" } })).status).toBe("SUPERSEDED")
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "CREDIT_CHECKS_RECOMPUTED" }, orderBy: { createdAt: "desc" } })
    expect(audit.newValue).toMatchObject({ reopened: [`NO_PAYSLIP:${noPayslip.id}`], superseded: [expect.stringMatching(/^NO_STATEMENT:/)] })
  })

  it("does not read a statement the client uploaded without POPIA consent", async () => {
    const otherDoc = `${docId}_portal`
    await prisma.clientDocument.create({
      data: {
        id: otherDoc, tenantId, clientId, docType: "BANK_STATEMENT", fileUrl: "", fileName: "portal.pdf",
        mimeType: "application/pdf", storagePath: join(dir, "statement.pdf"), uploadedByType: "client", extractionStatus: "skipped",
      },
    })
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(await openCodes()).toContain("NOT_READ_NO_CONSENT")
    expect(await prisma.statementAnalysis.count({ where: { tenantId, clientDocumentId: otherDoc } })).toBe(0)
  })

  it("raises a client's findings on every undecided application once a statement is read", async () => {
    await prisma.loanProduct.create({
      data: { id: `product2_${token}`, tenantId, code: `RC2-${token}`, name: "Second product", productType: "PERSONAL", minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL" },
    })
    await prisma.loanApplication.create({
      data: { id: `${appId}_2`, tenantId, reference: `APP2-${token}`, clientId, productId: `product2_${token}`, appliedAmount: 500_000, appliedTermDays: 30, status: "SUBMITTED" },
    })
    await recomputeClientApplications(tenantId, clientId)
    const second = await prisma.applicationCheckFlag.findMany({ where: { tenantId, applicationId: `${appId}_2`, status: "OPEN" } })
    // The Synthlend debt was declared by an earlier case, so it is not raised anew here.
    expect(second.map((f) => f.code)).toEqual(expect.arrayContaining(["GAMBLING", "PAYDAY_LENDER", "RETURNED_DEBIT"]))
  })

  it("does not recompute a decided application", async () => {
    const before = await openCodes()
    await prisma.loanApplication.update({ where: { id: appId, tenantId }, data: { status: "DECLINED", decisionReason: "Test" } })
    await prisma.clientDocument.update({ where: { id: docId, tenantId }, data: { deletedAt: new Date() } })
    const result = await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(result?.recomputed).toBe(false)
    expect(await openCodes()).toEqual(before)
  })
})
