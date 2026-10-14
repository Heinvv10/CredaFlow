/**
 * Real-Postgres proof of the screening workflow: the simulated provider, the
 * run recorder, the review rules and the approval gate, as the routes call
 * them. Run against a throwaway database migrated with every migration:
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/screening-workflow.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { runScreening } from "./run"
import { reviewScreeningCheck } from "./review"
import { borrowerScreeningGate, readSubjectScreening } from "./gate"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `tenant_scrwf_${token}`
const admin = { id: `admin_${token}`, email: `admin-${token}@test.invalid`, role: "ADMIN" as const, totpVerified: true }
const manager = { id: `mgr_${token}`, email: `mgr-${token}@test.invalid`, role: "BRANCH_MANAGER" as const, totpVerified: true }
const officer = { id: `officer_${token}`, email: `officer-${token}@test.invalid` }
const superAdmin = { id: `sa_${token}`, email: `sa-${token}@test.invalid`, role: "SUPER_ADMIN" as const, totpVerified: true }

async function client(lastName: string): Promise<string> {
  const id = `client_${lastName.toLowerCase().replace(/[^a-z]/g, "")}_${randomUUID().slice(0, 8)}_${token}`
  await db.client.create({ data: {
    id, tenantId, reference: `REF-${id}`, idNumber: `ID-${id}`, firstName: "Synthetic", lastName,
    email: `${id}@test.invalid`, phone: "+27820000000",
  } })
  return id
}

// The officer starts runs; the admin reviews them (maker-checker).
const run = (clientId: string) => runScreening({ tenantId, subject: { clientId }, trigger: "MANUAL", actor: officer })
type Actor = { id: string; email: string; role: "ADMIN" | "BRANCH_MANAGER" | "SUPER_ADMIN"; totpVerified: boolean }
const review = (checkId: string, decision: "FALSE_POSITIVE" | "ACCEPTED" | "REJECTED", actor: Actor = admin) =>
  reviewScreeningCheck({ tenantId, checkId, decision, reason: "Synthetic reviewer reason for the integration proof.", actor, totpWaived: false })
const openCheck = async (clientId: string) =>
  (await db.screeningCheck.findFirst({ where: { tenantId, clientId, result: { in: ["POSSIBLE_MATCH", "CONFIRMED_MATCH"] } }, orderBy: { createdAt: "desc" } }))!
const gate = (clientId: string) => borrowerScreeningGate({ tenantId, borrower: { clientId, entityId: null }, applicationId: "app-n/a", actor: officer })

suite("screening workflow against Postgres", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `scrwf-${token}`, name: "Screening workflow test" } })
    await db.tenantConfig.create({ data: { tenantId, screeningProvider: "simulated", screeningReviewMinRole: "ADMIN", requireStaffTotp: true } })
    await db.user.createMany({ data: [admin, manager, superAdmin].map((u) => ({
      id: u.id, tenantId, email: u.email, password: "synthetic", role: u.role,
    })) })
    await db.user.create({ data: { id: officer.id, tenantId, email: officer.email, password: "synthetic", role: "CREDIT_OFFICER" } })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  afterAll(async () => db.$disconnect())

  it("screens a clear client CLEAR, marks them CLEARED, and the gate allows approval", async () => {
    const id = await client("Example")
    const ran = await run(id)
    expect(ran).toMatchObject({ configured: true, state: { state: "CLEAR" }, providerError: null })
    expect((await db.client.findUnique({ where: { id } }))?.amlScreeningStatus).toBe("CLEARED")
    expect(await db.screeningCheck.count({ where: { tenantId, clientId: id } })).toBe(3)
    expect((await gate(id)).allowed).toBe(true)
    expect(await db.auditLog.count({ where: { tenantId, action: "SCREENING_RUN", entityId: id } })).toBe(1)
  })

  it("refers a PEP: approval blocked until a senior with 2FA (not the run's starter) accepts it; the identical confirmed match carries on re-screen", async () => {
    const id = await client("Fixture-Pep")
    expect((await run(id) as { state: { state: string } }).state.state).toBe("REFER")
    expect((await db.client.findUnique({ where: { id } }))?.amlScreeningStatus).toBe("FLAGGED")
    expect(await gate(id)).toMatchObject({ allowed: false, state: { state: "REFER" } })

    const check = await openCheck(id)
    expect(await review(check.id, "ACCEPTED", { ...officer, role: "ADMIN", totpVerified: true })).toMatchObject({ ok: false, code: "own_run" })
    expect(await review(check.id, "ACCEPTED", manager)).toMatchObject({ ok: false, code: "role_below_policy" })
    expect(await review(check.id, "ACCEPTED", { ...admin, totpVerified: false })).toMatchObject({ ok: false, code: "totp_required" })
    expect(await gate(id)).toMatchObject({ allowed: false })

    expect(await review(check.id, "ACCEPTED")).toMatchObject({ ok: true, state: { state: "CLEAR" } })
    expect((await db.client.findUnique({ where: { id } }))?.amlScreeningStatus).toBe("CLEARED")
    expect((await gate(id)).allowed).toBe(true)
    expect(await review(check.id, "REJECTED")).toMatchObject({ ok: false, code: "already_decided" })
    expect(await db.auditLog.count({ where: { tenantId, action: "SCREENING_MATCH_REVIEWED", entityId: check.id } })).toBe(1)

    // Same-level carry (policy 2026-10-14): the identical confirmed match is
    // carried, so the accepted PEP is not re-referred every cycle.
    expect(await run(id)).toMatchObject({ state: { state: "CLEAR" } })
    expect(await openCheck(id)).toMatchObject({ decision: "ACCEPTED", carriedFromCheckId: check.id, reviewedById: null })
  })

  it("never carries a cleared sanctions possible match: each re-screen refers it to a reviewer again", async () => {
    const id = await client("Fixture-Possible")
    await run(id)
    const check = await openCheck(id)
    expect(await review(check.id, "FALSE_POSITIVE")).toMatchObject({ ok: true, state: { state: "CLEAR" } })
    expect(await run(id)).toMatchObject({ state: { state: "REFER" } })
    expect((await openCheck(id)).carriedFromCheckId).toBeNull()
  })

  it("records a run the approval gate started as a system run, so the approver may still review it", async () => {
    const id = await client("Fixture-Pep")
    const gated = await borrowerScreeningGate({ tenantId, borrower: { clientId: id, entityId: null }, applicationId: "app-n/a", actor: admin })
    expect(gated).toMatchObject({ allowed: false, state: { state: "REFER" } })
    const check = await openCheck(id)
    expect(check.triggeredById).toBeNull()
    expect(await db.auditLog.count({ where: { tenantId, action: "SCREENING_RUN", entityId: id, userId: admin.id } })).toBe(1)
    expect(await review(check.id, "ACCEPTED")).toMatchObject({ ok: true })
  })

  it("hard-blocks a confirmed sanctions match: no reviewer clears it and every re-run still blocks", async () => {
    const id = await client("Fixture-Sanction")
    // The database raised a sticky block the moment the match was recorded.
    expect(await run(id)).toMatchObject({ state: { state: "BLOCKED", reason: "STICKY_BLOCK" } })
    const check = await openCheck(id)
    expect(await db.screeningBlock.findFirst({ where: { tenantId, sourceCheckId: check.id } })).toMatchObject({ reason: "SANCTIONS_MATCH", liftedAt: null })
    for (const decision of ["FALSE_POSITIVE", "ACCEPTED", "REJECTED"] as const) {
      expect(await review(check.id, decision, superAdmin)).toMatchObject({ ok: false, code: "sanctions_not_clearable" })
    }
    expect((await db.screeningCheck.findUnique({ where: { id: check.id } }))?.decision).toBeNull()
    expect(await gate(id)).toMatchObject({ allowed: false, state: { state: "BLOCKED" } })
    expect(await run(id)).toMatchObject({ state: { state: "BLOCKED" } })
    expect((await db.client.findUnique({ where: { id } }))?.amlScreeningStatus).toBe("FLAGGED")
  })

  it("lets a possible sanctions match be found a false positive, never accepted", async () => {
    const id = await client("Fixture-Possible")
    expect(await run(id)).toMatchObject({ state: { state: "REFER" } })
    const check = await openCheck(id)
    expect(await review(check.id, "ACCEPTED")).toMatchObject({ ok: false, code: "sanctions_not_acceptable" })
    expect(await review(check.id, "FALSE_POSITIVE")).toMatchObject({ ok: true, state: { state: "CLEAR" } })
  })

  it("records a provider error as INCOMPLETE, which blocks", async () => {
    const id = await client("Fixture-Error")
    const ran = await run(id)
    expect(ran).toMatchObject({ state: { state: "INCOMPLETE" }, providerError: expect.stringContaining("Simulated provider error") })
    expect(await db.screeningCheck.count({ where: { tenantId, clientId: id, result: "ERROR" } })).toBe(3)
    expect((await db.client.findUnique({ where: { id } }))?.amlScreeningStatus).toBe("PENDING")
  })

  it("re-screens before approval when the latest run is stale", async () => {
    const id = await client("Fixture-Media")
    await run(id)
    await db.$executeRawUnsafe(`ALTER TABLE "ScreeningCheck" DISABLE TRIGGER "ScreeningCheck_guard_record"`)
    try {
      await db.screeningCheck.updateMany({ where: { tenantId, clientId: id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } })
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "ScreeningCheck" ENABLE TRIGGER "ScreeningCheck_guard_record"`)
    }
    const before = await db.screeningCheck.count({ where: { tenantId, clientId: id } })
    expect(await gate(id)).toMatchObject({ allowed: false, state: { state: "REFER" } })
    expect(await db.screeningCheck.count({ where: { tenantId, clientId: id, trigger: "PRE_APPROVAL" } })).toBe(3)
    expect(await db.screeningCheck.count({ where: { tenantId, clientId: id } })).toBe(before + 3)
  })

  it("refuses the simulated provider on a deployed build, and does not accept stored simulated evidence there", async () => {
    const id = await client("Deployed")
    await run(id)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    expect((await readSubjectScreening(tenantId, { clientId: id })).state).toMatchObject({ state: "BLOCKED", reason: "SIMULATED_NOT_PERMITTED" })
    const ran = await run(id)
    expect(ran).toMatchObject({ state: { state: "BLOCKED", reason: "SIMULATED_NOT_PERMITTED" } })
    const latest = await db.screeningCheck.findMany({ where: { tenantId, clientId: id }, orderBy: { createdAt: "desc" }, take: 3 })
    expect(latest.map((c) => [c.result, c.errorCode])).toEqual(Array(3).fill(["ERROR", "SIMULATION_FORBIDDEN"]))
  })
})
