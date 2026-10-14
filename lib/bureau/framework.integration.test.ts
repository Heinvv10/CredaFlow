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
    // Experian first, with no credentials and no dry-run (stubbed below), so the
    // primary fails; XDS is not an approval bureau, so it is skipped; the
    // simulator answers.
    await prisma.tenantConfig.create({ data: { tenantId, bureauProviderOrder: ["experian", "xds", "simulated"] } })
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

  it("falls back from the failing primary, skips a non-approval bureau, and persists every attempt in order", async () => {
    // Experian's live path with nothing configured: NOT_CONFIGURED, not a dry-run.
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("EXPERIAN_DRY_RUN", "")
    vi.stubEnv("EXPERIAN_USERNAME", "")
    try {
      await expect(runWithTenant(tenantId, () => runBureauReviewCheck(review))).resolves.toBe("stored")
    } finally {
      vi.unstubAllEnvs()
    }

    const rows = await prisma.creditBureauCheck.findMany({ where: { tenantId, applicationId }, orderBy: { attempt: "asc" } })
    expect(rows.map((r) => [r.attempt, r.provider, r.status, r.ok])).toEqual([
      [1, "experian", "NOT_CONFIGURED", false],
      [2, "xds", "SKIPPED_NOT_APPROVABLE", false],
      [3, "simulated", "OK", true],
    ])
    expect(rows[0].errorMessage).toMatch(/not configured/)
    expect(rows[2].obligations).toMatchObject({ simulated: true, simulationSource: "simulated-bureau" })
    expect(rows.every((r) => r.reviewGeneration === reviewGeneration && r.subjectFingerprint)).toBe(true)

    const record = await prisma.complianceRecord.findFirstOrThrow({ where: { tenantId, referenceId: applicationId, type: "CREDIT_BUREAU_CHECK" } })
    expect(record).toMatchObject({ status: "COMPLETED", data: { provider: "simulated" } })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "BUREAU_ENQUIRY_RUN", entityId: applicationId } })
    expect(audit.newValue).toMatchObject({ provider: "simulated", simulated: true })
  })

  it("the approval read takes the fresh report and refuses it once older than the tenant's window", async () => {
    const fresh = await approvalRead()
    expect(fresh?.provider).toBe("simulated")

    const age = (days: number) => runWithTenant(tenantId, () => prisma.creditBureauCheck.update({
      where: { id: fresh!.id, tenantId }, data: { createdAt: new Date(Date.now() - days * DAY) },
    }))

    // The default window is the 60-day ceiling: 59 days old still counts, 61 never does.
    expect((await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId } })).bureauMaxAgeDays).toBe(60)
    await age(59)
    await expect(approvalRead()).resolves.toMatchObject({ id: fresh!.id })
    await age(61)
    await expect(approvalRead()).resolves.toBeNull()

    // A tenant that tightens to 30 days refuses a 31-day-old report; 45 days accepts it.
    await age(31)
    await prisma.tenantConfig.update({ where: { tenantId }, data: { bureauMaxAgeDays: 30 } })
    await expect(approvalRead()).resolves.toBeNull()
    await prisma.tenantConfig.update({ where: { tenantId }, data: { bureauMaxAgeDays: 45 } })
    await expect(approvalRead()).resolves.toMatchObject({ id: fresh!.id })
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
