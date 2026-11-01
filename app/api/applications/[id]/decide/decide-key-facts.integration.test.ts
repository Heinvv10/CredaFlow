/**
 * Real-Postgres proof that a KEY_FACTS application (a non-NCA instance: Lesotho) is approved through
 * the real decide route without the South African evidence, and that an NCA_PASQ application still
 * needs all of it. Every other approval gate runs for real, as in decision-log.integration.test.ts (the
 * submission snapshot, composite KYC, the affordability gate, screening, the credit-check recompute, the
 * locked re-verification and every LoanApplication trigger); nothing is installed with
 * session_replication_role.
 *
 * Each suite has its own throwaway database, because the instance's jurisdiction is a property of the
 * whole database. Mocked, as in decision-log.integration.test.ts: the RLS-bound client, the session
 * guard, the tenant frame, outbound notifications.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/decide/decide-key-facts.integration.test.ts'
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "" }))

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_target, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: "LOAN_ADMIN", tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Decide key facts IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async () => undefined),
}))

import { createAppPrismaClient } from "@/lib/prisma"
import { readAffordabilitySnapshotStore } from "@/lib/affordability/snapshot"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "@/lib/non-nca-documents/ls-stack.integration-fixture"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { POST } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)

function decide(id: string, fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return POST(new NextRequest(`http://localhost/api/applications/${id}/decide`, { method: "POST", body: form }), { params: Promise.resolve({ id }) })
}

/** One suite on its own throwaway database whose instance is `jurisdiction`. */
function instanceSuite(label: string, jurisdiction: "LS" | "ZA") {
  const role = `cf_dkf_${jurisdiction.toLowerCase()}_${t}`
  const stack = stackOf(jurisdiction, t)
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient> | undefined
  const db = () => fresh.db
  const underReview = async (id: string, opts: { nca: boolean; documents?: boolean; income?: number; bureau?: boolean }) => {
    await seedUnderReview(db(), stack, id, opts)
    return db().loanApplication.findUniqueOrThrow({ where: { id } })
  }

  async function setup() {
    fresh = await createThrowawayDb({ instance: { jurisdiction, currency: jurisdiction === "LS" ? "LSL" : "ZAR" } })
    holder.tenantId = stack.tenant
    holder.userId = stack.officer
    await seedStack(db(), stack, { code: "DKF" })
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }

  async function teardown() {
    vi.unstubAllEnvs()
    holder.app = null
    await app?.$disconnect()
    await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
    await fresh?.drop()
    const admin = new PrismaClient()
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
    await admin.$disconnect()
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
  }

  return { label, db, tenant: stack.tenant, officer: stack.officer, underReview, clearFlags: (id: string) => clearOpenFlags(db(), stack, id), setup, teardown }
}

const ls = instanceSuite("Lesotho", "LS")
suite("decide, a Lesotho (KEY_FACTS) instance: the South African evidence is not asked for (real Postgres, real route)", () => {
  beforeAll(() => ls.setup(), 240_000)
  afterAll(() => ls.teardown(), 60_000)

  it("approves an application with no credit-life election, no affordability declaration, no reckless-lending assessment and no bureau check", async () => {
    const id = `ok-${t}`
    const application = await ls.underReview(id, { nca: false })
    expect(application.disclosureRegime).toBe("KEY_FACTS")
    expect(application.creditLifeElection).toBeNull()
    expect(application.clientAffordabilityDeclaredAt).toBeNull()
    expect(application.recklessLendingAssessed).toBe(false)
    await ls.clearFlags(id)

    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)

    const approved = await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(approved).toMatchObject({ status: "APPROVED", disclosureRegime: "KEY_FACTS", approvedById: ls.officer, repaymentMethod: "EFT", pasqVersion: null, pasqDocumentId: null })
    expect(await ls.db().auditLog.count({ where: { tenantId: ls.tenant, entityId: id, action: "LOAN_APPROVED" } })).toBe(1)
    const approval = readAffordabilitySnapshotStore(approved.affordabilityResult).approval
    // The bureau slot records that no check applied, not that one was waived; credit life is priced as no offer.
    expect(approval?.bureauEvidence).toMatchObject({ mode: "CHECK", check: null, override: null })
    expect(approval?.inputs).toMatchObject({ creditLifePremiumCents: 0 })
    expect(await ls.db().creditDecisionRecord.count({ where: { tenantId: ls.tenant, applicationId: id } })).toBe(2)
  })

  it("still holds approval for what applies in every jurisdiction: KYC, the credit checks, and an unaffordable loan", async () => {
    const noDocs = `nodocs-${t}`
    await ls.underReview(noDocs, { nca: false, documents: false })
    const kyc = await decide(noDocs, { action: "approve", repaymentMethod: "EFT" })
    expect(kyc.status).toBe(422)
    expect(await kyc.json()).toMatchObject({ error: "KYC not complete." })

    const open = `open-${t}`
    await ls.underReview(open, { nca: false })
    const checks = await decide(open, { action: "approve", repaymentMethod: "EFT" })
    expect(checks.status, "the credit-check recompute raises its findings and they block until cleared").toBe(409)
    expect(await checks.json()).toMatchObject({ openChecks: expect.any(Array) })

    const poor = `poor-${t}`
    await ls.underReview(poor, { nca: false, income: 900_000 })
    await ls.clearFlags(poor)
    const afford = await decide(poor, { action: "approve", repaymentMethod: "EFT" })
    expect(afford.status).toBe(422)
    expect(String((await afford.json()).error)).toMatch(/^Affordability gate/)
    for (const id of [noDocs, open, poor]) expect((await ls.db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
  })
})

const za = instanceSuite("South Africa", "ZA")
suite("decide, a South African (NCA_PASQ) instance: the same application still needs every item (real Postgres, real route)", () => {
  beforeAll(() => za.setup(), 240_000)
  afterAll(() => za.teardown(), 60_000)

  it("refuses an application with no affordability declaration and no reckless-lending assessment, and then no bureau check", async () => {
    const id = `za-${t}`
    const application = await za.underReview(id, { nca: false })
    expect(application.disclosureRegime).toBe("NCA_PASQ")
    // No credit-life election either: the credit-life gate speaks first.
    const first = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(first.status).toBe(422)
    expect(await first.json()).toMatchObject({ missingComplianceEvidence: ["credit-life election"] })
  })

  it("an NCA application with a credit-life disclosure but no declaration or assessment is refused for exactly those", async () => {
    const id = `za2-${t}`
    await za.underReview(id, { nca: true })
    await za.db().loanApplication.update({ where: { id }, data: { clientAffordabilityDeclaredAt: null, recklessLendingAssessed: false, recklessLendingAssessedAt: null, recklessLendingAssessedById: null } })
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ missingComplianceEvidence: ["client affordability declaration", "reckless-lending assessment"] })
  })

  it("an NCA application with everything but a bureau check is refused for the bureau", async () => {
    const id = `za3-${t}`
    await za.underReview(id, { nca: true, bureau: false })
    const res = await decide(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ bureauMissing: true, requiresOverride: true })
  })
})
