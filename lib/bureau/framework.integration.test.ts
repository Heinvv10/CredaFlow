/**
 * The bureau framework against a migrated Postgres: a failing primary bureau
 * falls back and every attempt is persisted; the approval-path bureau read
 * refuses a report older than the tenant's window; the window's CHECK holds;
 * and a TEST bureau-submission file reaches the local outbox byte-identical
 * to the ledger, without touching the LIVE once-only ledger.
 *
 *   RUN_BUREAU_FRAMEWORK_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/bureau/framework.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { approvalBureauCheckWhere, bureauMaxAgeDays } from "@/lib/compliance/bureau"
import { runBureauReviewCheck } from "@/lib/compliance/bureau-review"
import { createBureauLoan, createBureauTenant, sast, syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { generateDaily } from "@/lib/bureau-submission/generate"
import { sha256Of } from "@/lib/bureau-submission/render"

vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

const suite = process.env.RUN_BUREAU_FRAMEWORK_IT === "1" ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const DAY = 24 * 60 * 60 * 1000

suite.sequential("bureau framework (real Postgres)", () => {
  const tenantId = `t_bfw_${token}`
  const clientId = `c_bfw_${token}`
  const applicationId = `a_bfw_${token}`
  const reviewGeneration = `g_bfw_${token}`
  const review = { tenantId, applicationId, clientId, reviewGeneration }

  const approvalRead = async () => {
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { bureauMaxAgeDays: true } })
    return prisma.creditBureauCheck.findFirst({
      where: approvalBureauCheckWhere({ ...review, maxAgeDays: bureauMaxAgeDays(config) }),
      orderBy: { createdAt: "desc" },
    })
  }

  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: tenantId, slug: `bfw-${token}`, name: "Bureau framework IT" } })
    // XDS first: a skeleton with no credentials, so the primary fails and the run falls back.
    await prisma.tenantConfig.create({ data: { tenantId, bureauProviderOrder: ["xds", "simulated"] } })
    await prisma.client.create({
      data: {
        id: clientId, tenantId, reference: `CLI-${token}`, idNumber: syntheticSaId(), firstName: "Synthetic",
        lastName: "Bureau", email: `${token}@client.invalid`, phone: "+27820000000", popiaConsentGiven: true,
      },
    })
    await prisma.loanProduct.create({
      data: {
        id: `p_bfw_${token}`, tenantId, code: `BFW-${token}`, name: "Bureau framework product", productType: "PERSONAL",
        minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL",
      },
    })
    await prisma.loanApplication.create({
      data: {
        id: applicationId, tenantId, reference: `APP-${token}`, clientId, productId: `p_bfw_${token}`,
        appliedAmount: 500_000, appliedTermDays: 30, status: "UNDER_REVIEW", submittedAt: new Date(), bureauReviewGeneration: reviewGeneration,
      },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("falls back from the failing primary and persists every attempt, in order", async () => {
    await expect(runWithTenant(tenantId, () => runBureauReviewCheck(review))).resolves.toBe("stored")

    const rows = await prisma.creditBureauCheck.findMany({ where: { tenantId, applicationId }, orderBy: { attempt: "asc" } })
    expect(rows.map((r) => [r.attempt, r.provider, r.status, r.ok])).toEqual([
      [1, "xds", "NOT_CONFIGURED", false],
      [2, "simulated", "OK", true],
    ])
    expect(rows[0].errorMessage).toMatch(/not configured/)
    expect(rows[1].obligations).toMatchObject({ simulated: true, simulationSource: "simulated-bureau" })
    expect(rows.every((r) => r.reviewGeneration === reviewGeneration && r.subjectFingerprint)).toBe(true)

    const record = await prisma.complianceRecord.findFirstOrThrow({ where: { tenantId, referenceId: applicationId, type: "CREDIT_BUREAU_CHECK" } })
    expect(record).toMatchObject({ status: "COMPLETED", data: { provider: "simulated" } })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "BUREAU_ENQUIRY_RUN", entityId: applicationId } })
    expect(audit.newValue).toMatchObject({ provider: "simulated", simulated: true })
  })

  it("the approval read takes the fresh report and refuses it once older than the tenant's window", async () => {
    const fresh = await approvalRead()
    expect(fresh?.provider).toBe("simulated")

    // 31 days old against the default 30-day window.
    await runWithTenant(tenantId, () => prisma.creditBureauCheck.update({ where: { id: fresh!.id, tenantId }, data: { createdAt: new Date(Date.now() - 31 * DAY) } }))
    await expect(approvalRead()).resolves.toBeNull()

    // A tenant that allows 45 days still accepts it; one that allows 14 never did.
    await prisma.tenantConfig.update({ where: { tenantId }, data: { bureauMaxAgeDays: 45 } })
    await expect(approvalRead()).resolves.toMatchObject({ id: fresh!.id })
    await prisma.tenantConfig.update({ where: { tenantId }, data: { bureauMaxAgeDays: 14 } })
    await expect(approvalRead()).resolves.toBeNull()
  })

  it("the database refuses a window above the 60-day ceiling", async () => {
    await expect(prisma.tenantConfig.update({ where: { tenantId }, data: { bureauMaxAgeDays: 61 } }))
      .rejects.toThrow(/TenantConfig_bureauMaxAgeDays_range/)
  })

  it("delivers a TEST file to the local outbox byte-identical to the ledger, writing no LIVE row", async () => {
    const outbox = mkdtempSync(join(tmpdir(), "bureau-outbox-it-"))
    const saved = process.env.BUREAU_SUBMISSION_TEST_OUTBOX
    process.env.BUREAU_SUBMISSION_TEST_OUTBOX = outbox
    try {
      const t = await createBureauTenant(prisma as never)
      await createBureauLoan(prisma as never, t, { startDay: "2026-08-20", dueDays: ["2026-09-20", "2026-10-20"] })
      const result = await runWithTenant(t.tenantId, () => generateDaily(prisma, {
        tenantId: t.tenantId, day: "2026-08-20", mode: "TEST", now: sast("2026-08-21", "00:20:00"), actor: { source: "cron" },
      }))
      if (result.outcome !== "GENERATED") throw new Error(`expected GENERATED, got ${result.outcome}`)
      expect(result.push).toBe("DELIVERED")

      const delivered = readFileSync(join(outbox, result.fileName), "latin1")
      expect(sha256Of(delivered)).toBe(result.sha256)
      expect(await prisma.bureauSubmissionRecord.count({ where: { tenantId: t.tenantId, mode: "LIVE" } })).toBe(0)
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: "BUREAU_SUBMISSION_PUSHED" } })
      expect(audit.newValue).toMatchObject({ outcome: "DELIVERED", mode: "TEST", transport: "local-directory" })
      expect(JSON.stringify(audit.newValue)).not.toContain(delivered.slice(0, 40))
    } finally {
      if (saved === undefined) delete process.env.BUREAU_SUBMISSION_TEST_OUTBOX
      else process.env.BUREAU_SUBMISSION_TEST_OUTBOX = saved
      rmSync(outbox, { recursive: true, force: true })
    }
  })
})
