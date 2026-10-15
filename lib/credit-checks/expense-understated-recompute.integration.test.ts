/**
 * EXPENSE_UNDERSTATED through recomputeApplicationFlags against a migrated
 * database, with the check switched on for this file only (it ships off):
 * expenses never captured do not flag, an explicit R0 declaration does, and a
 * changed declaration raises a successor that supersedes the older OPEN
 * finding through ApplicationCheckFlag_guard_record, audited.
 *
 *   RUN_CREDIT_CHECKS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/credit-checks/expense-understated-recompute.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { syntheticStatement } from "@/lib/statement-analysis/fixtures/dataset"
import { buildCapitecStatement } from "@/lib/statement-analysis/fixtures/synthetic"
import { recomputeApplicationFlags } from "./recompute"

vi.mock("./policy", async (importOriginal) => ({ ...(await importOriginal<typeof import("./policy")>()), EXPENSE_UNDERSTATED_ENABLED: true }))

const RUN = process.env.RUN_CREDIT_CHECKS_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const CODE = "LIVING_SPEND_ABOVE_DECLARED"

suite("EXPENSE_UNDERSTATED recompute against Postgres", () => {
  const tenantId = `tenant_expflag_${token}`
  const clientId = `client_expflag_${token}`
  const appId = `app_expflag_${token}`
  const userId = `user_expflag_${token}`
  const dir = mkdtempSync(join(tmpdir(), "cf-expense-it-"))
  const livingFlags = () =>
    prisma.applicationCheckFlag.findMany({ where: { tenantId, applicationId: appId, code: CODE }, orderBy: { raisedAt: "asc" } })
  const declare = (monthlyExpenses: number, monthlyExpensesDeclaredAt: Date | null) =>
    prisma.client.update({ where: { id: clientId, tenantId }, data: { monthlyExpenses, monthlyExpensesDeclaredAt } })

  beforeAll(async () => {
    const pdf = Buffer.from(await buildCapitecStatement(syntheticStatement({ bank: "CAPITEC", start: "2026-07-01" })))
    const storagePath = join(dir, "statement.pdf")
    writeFileSync(storagePath, pdf)
    await prisma.tenant.create({ data: { id: tenantId, slug: `expflag-${token}`, name: "Expense flag test" } })
    await prisma.user.create({ data: { id: userId, tenantId, email: `officer-${token}@test.invalid`, password: "x", role: "LOAN_ADMIN" } })
    await prisma.client.create({
      data: {
        id: clientId, tenantId, reference: `CLI-${token}`, idNumber: `ID-${token}`, firstName: "Thabo", lastName: "Tester",
        email: `client-${token}@test.invalid`, phone: "+27820000000", monthlyIncome: 1_845_000,
      },
    })
    await prisma.loanProduct.create({
      data: { id: `product_${token}`, tenantId, code: `EF-${token}`, name: "Expense flag product", productType: "PERSONAL", minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL" },
    })
    await prisma.loanApplication.create({
      data: { id: appId, tenantId, reference: `APP-${token}`, clientId, productId: `product_${token}`, appliedAmount: 500_000, appliedTermDays: 30, status: "UNDER_REVIEW", submittedAt: new Date("2026-10-05T08:00:00Z") },
    })
    await prisma.clientDocument.create({
      data: {
        id: `doc_expflag_${token}`, tenantId, clientId, docType: "BANK_STATEMENT", fileUrl: "", fileName: "statement.pdf",
        mimeType: "application/pdf", storagePath, contentSha256: sha256DocumentBytes(pdf), extractionStatus: "done",
      },
    })
  })

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId } })
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" DISABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
      prisma.$executeRawUnsafe(`DELETE FROM "ApplicationCheckFlag" WHERE "tenantId" = '${tenantId}'`),
      prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" ENABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
    ])
    await prisma.statementAnalysis.deleteMany({ where: { tenantId } })
    await prisma.clientDocument.deleteMany({ where: { tenantId } })
    await prisma.loanApplication.deleteMany({ where: { tenantId } })
    await prisma.loanProduct.deleteMany({ where: { tenantId } })
    await prisma.client.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not flag expenses that were never captured", async () => {
    const result = await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(result).toMatchObject({ recomputed: true, declaredExpensesCents: null })
    expect(await livingFlags()).toEqual([])
  })

  it("flags an explicit R0 declaration, and reports the figure the checks used", async () => {
    await declare(0, new Date())
    const result = await recomputeApplicationFlags(tenantId, appId, { userId })
    expect(result?.declaredExpensesCents).toBe(0)
    const [flag, ...rest] = await livingFlags()
    expect(rest).toEqual([])
    expect(flag).toMatchObject({ status: "OPEN", evidence: expect.objectContaining({ declaredCents: 0 }) })
  })

  it("supersedes the older OPEN finding when a changed declaration raises its successor, audited", async () => {
    const [older] = await livingFlags()
    await declare(10_000, new Date())
    await recomputeApplicationFlags(tenantId, appId, { userId })
    const [first, second, ...rest] = await livingFlags()
    expect(rest).toEqual([])
    expect(first).toMatchObject({ id: older.id, status: "SUPERSEDED" })
    expect(second).toMatchObject({ status: "OPEN", evidence: expect.objectContaining({ declaredCents: 10_000 }) })
    expect((await livingFlags()).filter((f) => f.status === "OPEN").map((f) => f.id)).toEqual([second.id])
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "CREDIT_CHECKS_RECOMPUTED", entityId: appId }, orderBy: { createdAt: "desc" } })
    expect(audit.newValue).toMatchObject({ raised: [`${CODE}:${second.id}`], superseded: [`${CODE}:${older.id}`] })
  })

  it("reopens the earlier finding when the declaration returns to it, superseding the later one", async () => {
    const [r0, r100] = await livingFlags()
    await declare(0, new Date())
    await recomputeApplicationFlags(tenantId, appId, { userId })
    const byId = new Map((await livingFlags()).map((f) => [f.id, f.status]))
    expect(byId.get(r0.id)).toBe("OPEN")
    expect(byId.get(r100.id)).toBe("SUPERSEDED")
    expect((await livingFlags()).filter((f) => f.status === "OPEN").map((f) => f.id)).toEqual([r0.id])
  })

  it("never touches a cleared finding: a successor is raised beside it", async () => {
    const open = (await livingFlags()).find((f) => f.status === "OPEN")!
    await prisma.applicationCheckFlag.update({
      where: { id: open.id, tenantId },
      data: { status: "CLEARED", clearedById: userId, clearedAt: new Date(), clearReason: "Spouse pays the household costs; confirmed." },
    })
    const cleared = await prisma.applicationCheckFlag.findFirstOrThrow({ where: { id: open.id, tenantId } })
    await declare(20_000, new Date())
    await recomputeApplicationFlags(tenantId, appId, { userId })
    const flags = await livingFlags()
    // The cleared row is exactly as the officer left it: not superseded, not refreshed.
    expect(flags.find((f) => f.id === open.id)).toEqual(cleared)
    expect(flags.filter((f) => f.status === "OPEN").map((f) => (f.evidence as { declaredCents: number }).declaredCents)).toEqual([20_000])
  })

  it("keeps a finding OPEN when the new declaration raises none: only an officer closes it", async () => {
    await declare(5_000_000, new Date())
    await recomputeApplicationFlags(tenantId, appId, { userId })
    expect((await livingFlags()).filter((f) => f.status === "OPEN")).toHaveLength(1)
  })
})
