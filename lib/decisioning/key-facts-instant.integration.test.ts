/**
 * F7, tender 2.3.9, on real Postgres through the real routes: a client submits on the portal of a Lesotho lender and the
 * engine approves within 60 seconds, with every gate running for real, nothing installed with session_replication_role
 * and the instance's jurisdiction read from the database. And the same setting cannot be reached on a South African instance.
 *
 * Mocked, as ls-end-to-end.integration.test.ts does and for the same reasons: the RLS-bound client, the session guards, the
 * tenant frame, outbound notifications, the PDF renderer and file storage. The simulated bureau and simulated screening provider
 * run: a real Lesotho bureau is a go-live condition (docs/non-nca-go-live.md).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/decisioning/key-facts-instant.integration.test.ts
 */
import { randomInt, randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({
  app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", clientId: "", files: new Map<string, Buffer>(),
  /** While true the portal route's scheduling is held back, so a test can change the world between submission and decision. */
  hold: false, held: null as null | { tenantId: string; applicationId: string; clientId?: string; ip: string | null },
}))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_t, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: holder.clientId, role: "CLIENT", email: `${holder.clientId}@test.invalid` } })) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Staff", role: holder.role, tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Instant approval IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/storage", () => ({
  saveFile: async (buffer: Buffer) => { const path = `/mem/${holder.files.size}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", async (original) => ({ ...(await original<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => ({ legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))
vi.mock("@/lib/decisioning/schedule-digital", async (original) => {
  const actual = await original<typeof import("@/lib/decisioning/schedule-digital")>()
  return { ...actual, scheduleDigitalDecision: (input: NonNullable<typeof holder.held>) => { if (holder.hold) { holder.held = input; return Promise.resolve() } return actual.scheduleDigitalDecision(input) } }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { ENGINE_CONFIG_KIND, RULE_SET_KIND } from "@/lib/decisioning/change-payloads"
import { MATRIX_KIND } from "@/lib/approval/types"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "@/lib/non-nca-documents/gate.integration-fixture"
import { bankRefFor, lsFlow } from "@/lib/non-nca-documents/ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "@/lib/non-nca-documents/ls-stack.integration-fixture"
import { decideApplication } from "@/app/api/applications/[id]/decide/decide-application"
import { POST as decideRoute } from "@/app/api/applications/[id]/decide/route"
import { POST as portalApply } from "@/app/api/portal/applications/route"
import { POST as draftChange } from "@/app/api/maker-checker/route"
import { POST as actOnChange } from "@/app/api/maker-checker/[id]/[action]/route"
import { cleanIdNumber, seedDigitalBorrower } from "./key-facts-instant.integration-fixture"
import { scheduleDigitalDecision } from "./schedule-digital"
import { runWithTenant } from "@/lib/tenant-scope"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const SIXTY_SECONDS = 60_000

const passingRules = (productId: string | null) => ({
  productId, name: "Instant rules", effectiveFrom: "2026-01-01", challengerOnly: false, scorecard: null,
  rules: [{ id: "score", name: "Score below 560", outcome: "KNOCK_OUT", reasonCode: "BUREAU_SCORE_LOW", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "lt", value: 560 } }],
})
// Every bureau-checked applicant fails it: what an automated decline looks like.
const decliningRules = (productId: string) => ({
  ...passingRules(productId), name: "Declines all",
  rules: [{ id: "all", name: "Declines every score", outcome: "KNOCK_OUT", reasonCode: "BUREAU_SCORE_LOW", declineCategory: "BUREAU_SCORE", when: { field: "bureauScore", op: "gt", value: 1 } }],
})
const NOTICE = "Synthetic automated decision notice approved for this test."

/** The staff and the rule-set change steps a suite shares; each suite has its own database. */
function harness(jurisdiction: "LS" | "ZA") {
  const stack = stackOf(jurisdiction, t)
  const maker = `${stack.tenant}-maker`
  const checker = `${stack.tenant}-checker`
  const declineProduct = `${stack.product}-decl`
  const role = `cf_kfi_${jurisdiction.toLowerCase()}_${t}`
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient> | undefined
  const db = () => fresh.db
  const as = (userId: string, userRole: string) => { holder.userId = userId; holder.role = userRole }
  const json = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${randomInt(1, 250)}` } })

  /** A maker-checker change through the real routes: a maker drafts and submits, a SUPER_ADMIN approves. The last response. */
  async function change(kind: string, title: string, payload: object, approver: { id: string; role: string } = { id: checker, role: "SUPER_ADMIN" }) {
    as(maker, "ADMIN")
    const drafted = await draftChange(json("/api/maker-checker", { kind, title, payload }))
    const draftBody = await drafted.json()
    if (drafted.status !== 201) return { status: drafted.status, body: draftBody }
    const action = (id: string, verb: string) => actOnChange(json(`/api/maker-checker/${id}/${verb}`, {}), { params: Promise.resolve({ id, action: verb }) })
    const submitted = await action(draftBody.request.id, "submit")
    if (submitted.status !== 200) return { status: submitted.status, body: await submitted.json() }
    as(approver.id, approver.role)
    const approved = await action(draftBody.request.id, "approve")
    return { status: approved.status, body: await approved.json(), id: draftBody.request.id as string }
  }

  async function withdraw(id: string) {
    as(maker, "ADMIN")
    const res = await actOnChange(json(`/api/maker-checker/${id}/withdraw`, {}), { params: Promise.resolve({ id, action: "withdraw" }) })
    expect(res.status).toBe(200)
  }

  async function setup() {
    fresh = await createThrowawayDb({ instance: { jurisdiction, currency: jurisdiction === "LS" ? "LSL" : "ZAR" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "KFI", isDemoLender: true })
    await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: { bureauProviderOrder: ["simulated"] } })
    const old = new Date(Date.now() - 90 * 86_400_000)
    for (const [id, userRole] of [[maker, "ADMIN"], [checker, "SUPER_ADMIN"]] as const) {
      await db().user.create({ data: { id, tenantId: stack.tenant, email: `${id}@test.invalid`, password: "not-a-real-login", name: id, role: userRole, totpEnabled: true, lastTotpCounter: 1, createdAt: old } })
    }
    const base = await db().loanProduct.findUniqueOrThrow({ where: { id: stack.product } })
    await db().loanProduct.create({ data: { ...base, id: declineProduct, code: `${base.code}-D`, createdAt: undefined, updatedAt: undefined } as never })
    await createTemplate(db(), stack.tenant, KFS_KEY, "<h1>Key facts</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>")
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, "<h1>Agreement</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>")
    vi.stubEnv("TENANT_RLS", "on")
    const url = new URL(await createRlsRole(db(), fresh.url, role))
    url.searchParams.set("connection_limit", "5")
    app = createAppPrismaClient(url.toString())
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

  const engine = (over: object = {}) => ({ mode: "LIVE", channels: ["PORTAL"], productIds: [stack.product, declineProduct], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: false, automatedDeclineNotice: null, ...over })

  /** The client applies on the real portal route. Returns the application id. */
  async function apply(clientId: string, productId = stack.product, body: object = {}) {
    holder.clientId = clientId
    const product = await db().loanProduct.findUniqueOrThrow({ where: { id: productId } })
    const res = await portalApply(json("/api/portal/applications", { productCode: product.code, amount: 5000, termDays: 30, purpose: "School fees", ...body }))
    const created = await res.json()
    expect(res.status, JSON.stringify(created)).toBe(201)
    return created.id as string
  }

  /** The after-response task has run: the due row is complete. */
  async function settled(applicationId: string) {
    const deadline = Date.now() + 45_000
    for (;;) {
      const due = await db().autoDecisionDue.findFirst({ where: { tenantId: stack.tenant, applicationId } })
      if (due?.completedAt) return due
      if (Date.now() > deadline) throw new Error(`the digital decision of ${applicationId} never finished: ${JSON.stringify(due)}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** Submission held back at the scheduler: runs the same task the route would have scheduled, and waits for it. */
  async function release() {
    const input = holder.held!
    holder.held = null
    holder.hold = false
    let task: Promise<void> | undefined
    await scheduleDigitalDecision(input, (run) => { task = run() })
    await task
    return settled(input.applicationId)
  }

  const runOf = (applicationId: string) => db().autoDecisionRun.findFirstOrThrow({ where: { tenantId: stack.tenant, applicationId }, orderBy: { createdAt: "desc" }, include: { ruleSetVersion: true } })
  const applicationOf = (id: string) => db().loanApplication.findUniqueOrThrow({ where: { id } })
  return { stack, maker, checker, declineProduct, db, as, change, withdraw, setup, teardown, engine, apply, settled, release, runOf, applicationOf }
}

const ls = harness("LS")
const lesothoId = () => cleanIdNumber(() => `99${String(randomInt(10_000_000)).padStart(7, "0")}`)
const borrower = (id: string, over: { lastName?: string; income?: number } = {}) => seedDigitalBorrower(ls.db(), ls.stack, id, { files: holder.files, idNumber: lesothoId(), ...over })

suite("instant approval of a digital key-facts application (real Postgres, real routes, no bypass)", () => {
  beforeAll(async () => {
    await ls.setup()
    expect((await ls.change(RULE_SET_KIND, "rules", passingRules(null))).status).toBe(200)
    expect((await ls.change(RULE_SET_KIND, "declining", decliningRules(ls.declineProduct))).status).toBe(200)
    expect((await ls.change(ENGINE_CONFIG_KIND, "live", ls.engine())).status).toBe(200)
  }, 300_000)
  afterAll(() => ls.teardown(), 60_000)
  // Each case is its own day's worth of paid pulls: the fixtures share the unknown-address bucket.
  beforeEach(async () => { await ls.db().autoDecisionDue.updateMany({ where: { tenantId: ls.stack.tenant }, data: { chargedAt: null } }) })

  it("is off by default: a LIVE engine asks no bureau, approves nothing and refers the client's application to staff", async () => {
    const clientId = `off-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    await ls.settled(id)
    expect(await ls.runOf(id)).toMatchObject({ verdict: "REFER", execution: "REFERRED", reasonCodes: ["NO_BUREAU"] })
    expect(await ls.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", approvedById: null, automatedAffordabilityAttestedAt: null })
    expect(await ls.db().creditBureauCheck.count({ where: { applicationId: id } })).toBe(0)
  })

  it("the setting changes only through an approved change: a plain ADMIN cannot approve it, the row cannot be written directly, and the change is audited", async () => {
    const refused = await ls.change(ENGINE_CONFIG_KIND, "instant, by an admin", ls.engine({ keyFactsInstantApproval: true }), { id: ls.stack.senior, role: "ADMIN" })
    expect(refused.status).toBe(403)
    await expect(ls.db().$executeRawUnsafe(`UPDATE "DecisionEngineConfig" SET "keyFactsInstantApproval" = true WHERE "tenantId" = '${ls.stack.tenant}'`)).rejects.toThrow(/newly approved/)
    const staleRequest = await ls.db().changeRequest.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, kind: ENGINE_CONFIG_KIND, status: "APPROVED" }, orderBy: { createdAt: "asc" } })
    await expect(ls.db().$executeRawUnsafe(`UPDATE "DecisionEngineConfig" SET "keyFactsInstantApproval" = true, "changeRequestId" = '${staleRequest.id}' WHERE "tenantId" = '${ls.stack.tenant}'`)).rejects.toThrow(/newly approved|match the approved/)
    await ls.withdraw(refused.id!)

    const applied = await ls.change(ENGINE_CONFIG_KIND, "instant", ls.engine({ keyFactsInstantApproval: true }))
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)
    const audit = await ls.db().auditLog.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, action: "DECISION_ENGINE_CONFIG_APPLIED" }, orderBy: { createdAt: "desc" } })
    expect(audit).toMatchObject({ userId: ls.checker, oldValue: expect.objectContaining({ keyFactsInstantApproval: false }), newValue: expect.objectContaining({ keyFactsInstantApproval: true, makerId: ls.maker }) })
    expect(await ls.db().decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: ls.stack.tenant } })).toMatchObject({ keyFactsInstantApproval: true })
  })

  it("approves a client's digital submission in under 60 seconds, as an automated decision that names its rule set", async () => {
    const clientId = `instant-${t}`
    await borrower(clientId)
    const started = performance.now()
    const id = await ls.apply(clientId)
    await ls.settled(id)
    const wallClockMs = performance.now() - started

    const application = await ls.applicationOf(id)
    const run = await ls.runOf(id)
    const system = await ls.db().user.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, isSystem: true } })
    expect(run, JSON.stringify(await ls.db().applicationCheckFlag.findMany({ where: { applicationId: id, status: "OPEN" }, select: { code: true } }))).toMatchObject({ verdict: "APPROVE", execution: "APPROVED", mode: "LIVE", trigger: "DIGITAL_SUBMISSION", reasonCodes: ["RULES_PASSED"] })
    expect(application).toMatchObject({ status: "APPROVED", disclosureRegime: "KEY_FACTS", approvedById: system.id, automatedAffordabilityVersionId: run.ruleSetVersionId, recklessLendingAssessed: false })
    expect(application.automatedAffordabilityAttestedAt).toEqual(application.approvedAt)

    // Measured: what the run recorded, what the row says and what this test's clock saw.
    const decisionMs = application.approvedAt!.getTime() - application.submittedAt!.getTime()
    expect(run.submissionLatencyMs).toBeGreaterThan(0)
    expect(run.submissionLatencyMs!).toBeLessThan(SIXTY_SECONDS)
    expect(decisionMs).toBeGreaterThan(0)
    expect(decisionMs).toBeLessThan(SIXTY_SECONDS)
    expect(wallClockMs).toBeLessThan(SIXTY_SECONDS)
    process.stdout.write(`[F7] submission to decision: run ${run.submissionLatencyMs} ms, row ${decisionMs} ms, wall clock ${Math.round(wallClockMs)} ms\n`)

    // The record names the rule set and says no person decided.
    expect(run.ruleSetVersion).toMatchObject({ scopeKey: "ALL", name: "Instant rules" })
    const label = `ALL:v${run.ruleSetVersion.version}`
    const approved = await ls.db().auditLog.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, entityId: id, action: "LOAN_APPROVED" } })
    expect(approved).toMatchObject({ userId: system.id, newValue: expect.objectContaining({ automated: true, ruleVersion: label, affordabilityAttested: true }) })
    const record = await ls.db().creditDecisionRecord.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, applicationId: id, decision: "APPROVE" } })
    expect(record).toMatchObject({ actorType: "SYSTEM" })
    expect(record.ruleVersion).toContain(label)
    expect(record.inputsSnapshot).toMatchObject({ automated: { ruleVersion: label, affordabilityAttested: true } })
    // The evidence it rests on: a bureau check of this review, from the bureau the lender configured.
    expect(await ls.db().creditBureauCheck.findFirstOrThrow({ where: { applicationId: id, ok: true } })).toMatchObject({ provider: "simulated", reviewGeneration: application.bureauReviewGeneration })
  })

  it("a bureau enquiry spends the daily limits, as a South African one does: past them the application stays with staff, with no pull", async () => {
    const clientId = `charged-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    expect((await ls.settled(id)).chargedAt).not.toBeNull()

    vi.stubEnv("DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY", "1")
    const nextClient = `limited-${t}`
    await borrower(nextClient)
    const limited = await ls.apply(nextClient)
    expect((await ls.settled(limited)).outcome).toBe("RATE_LIMITED")
    vi.stubEnv("DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY", "")
    expect(await ls.applicationOf(limited)).toMatchObject({ status: "SUBMITTED", automatedAffordabilityAttestedAt: null })
    expect(await ls.db().creditBureauCheck.count({ where: { applicationId: limited } })).toBe(0)
  })

  it("with no bureau to ask the application goes to staff, and a South African bureau is not asked about a foreign consumer", async () => {
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { bureauProviderOrder: ["experian"] } })
    const clientId = `nobureau-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    await ls.settled(id)
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { bureauProviderOrder: ["simulated"] } })
    expect(await ls.runOf(id)).toMatchObject({ execution: "REFERRED", reasonCodes: ["NO_BUREAU"] })
    expect((await ls.applicationOf(id)).status).toBe("UNDER_REVIEW")
    expect(await ls.db().creditBureauCheck.findMany({ where: { applicationId: id }, select: { provider: true, ok: true } })).toEqual([{ provider: "experian", ok: false }])
  })

  it("the same setting does not reach what a person must assess: an unaffordable application is referred, not attested and not declined", async () => {
    const clientId = `poor-${t}`
    await borrower(clientId, { income: 1_000_000 })
    const id = await ls.apply(clientId)
    await ls.settled(id)
    expect(await ls.runOf(id)).toMatchObject({ execution: "REFERRED", verdict: "REFER", reasonCodes: ["AFFORDABILITY_NOT_ATTESTED"] })
    expect(await ls.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", automatedAffordabilityAttestedAt: null })
  })

  it("KYC still applies: unverified documents leave the application with staff, unreviewed", async () => {
    const clientId = `kyc-${t}`
    await borrower(clientId)
    await ls.db().clientDocument.updateMany({ where: { clientId, docType: "ID_COPY" }, data: { verified: false, verifiedAt: null, verifiedById: null } })
    const id = await ls.apply(clientId)
    expect((await ls.settled(id)).outcome).toBe("REVIEW_REFUSED_422")
    expect(await ls.applicationOf(id)).toMatchObject({ status: "SUBMITTED", automatedAffordabilityAttestedAt: null })
    expect(await ls.db().autoDecisionRun.count({ where: { applicationId: id } })).toBe(0)
  })

  it("screening still applies: a confirmed match stops the approval and the attestation", async () => {
    const clientId = `screen-${t}`
    await borrower(clientId, { lastName: "fixture-sanction" })
    const id = await ls.apply(clientId)
    await ls.settled(id)
    expect(await ls.runOf(id)).toMatchObject({ execution: "REFERRED", reasonCodes: expect.arrayContaining(["HARD_GATE_REFUSED"]) })
    expect(await ls.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", automatedAffordabilityAttestedAt: null })
  })

  it("the lender's own record of a death still applies, with no override: it is refused between submission and decision", async () => {
    const clientId = `deceased-${t}`
    await borrower(clientId)
    holder.hold = true
    const id = await ls.apply(clientId)
    await ls.db().client.update({ where: { id: clientId }, data: { deceasedAt: new Date() } })
    await ls.release()
    expect(await ls.runOf(id)).toMatchObject({ execution: "REFERRED", reasonCodes: expect.arrayContaining(["HARD_GATE_REFUSED"]) })
    expect((await ls.runOf(id)).executionNote).toMatch(/cannot be overridden/)
    expect(await ls.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", automatedAffordabilityAttestedAt: null })
  })

  it("an open credit check still stops it: a payslip whose figures did not validate waits for a person", async () => {
    const clientId = `flag-${t}`
    await borrower(clientId)
    await ls.db().clientDocument.updateMany({ where: { clientId, docType: "PAYSLIP" }, data: { extractionResult: { netIncome: { value: 1_845_000, validated: false }, payDate: { value: "2026-10-25" }, employeeName: { value: "Thabo Tester" } } } })
    const id = await ls.apply(clientId)
    await ls.settled(id)
    expect(await ls.runOf(id)).toMatchObject({ execution: "REFERRED", reasonCodes: expect.arrayContaining(["HARD_GATE_REFUSED"]) })
    expect(await ls.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", automatedAffordabilityAttestedAt: null })
  })

  it("an automated decline still needs the s71 sign-off: without it the decline is referred, with it the decline stands", async () => {
    const heldBack = `s71-${t}`
    await borrower(heldBack)
    const first = await ls.apply(heldBack, ls.declineProduct)
    await ls.settled(first)
    expect(await ls.runOf(first)).toMatchObject({ execution: "REFERRED", reasonCodes: expect.arrayContaining(["S71_NOT_SIGNED_OFF"]) })
    expect(await ls.applicationOf(first)).toMatchObject({ status: "UNDER_REVIEW", declineCategory: null })

    expect((await ls.change(ENGINE_CONFIG_KIND, "signed", ls.engine({ keyFactsInstantApproval: true, s71SignOff: true, automatedDeclineNotice: NOTICE }))).status).toBe(200)
    const signed = `s71b-${t}`
    await borrower(signed)
    const second = await ls.apply(signed, ls.declineProduct)
    await ls.settled(second)
    expect(await ls.runOf(second)).toMatchObject({ execution: "DECLINED", noticeText: NOTICE })
    expect(await ls.applicationOf(second)).toMatchObject({ status: "DECLINED", automatedAffordabilityAttestedAt: null })
  })

  it("a person pressing 'run decision engine' does not get an automated attestation: it is a digital submission's alone", async () => {
    const clientId = `manual-${t}`
    await borrower(clientId)
    holder.hold = true
    const id = await ls.apply(clientId)
    holder.held = null
    holder.hold = false
    const review = await import("@/app/api/applications/[id]/review/review-application")
    await runWithTenant(ls.stack.tenant, () => review.startApplicationReview({ tenant: { id: ls.stack.tenant }, user: { id: ls.stack.officer, email: "o@test.invalid" }, id, autoDecisionTrigger: "MANUAL" }))
    expect(await ls.runOf(id)).toMatchObject({ execution: "REFERRED", reasonCodes: ["NOT_A_DIGITAL_SUBMISSION"] })
    expect((await ls.applicationOf(id)).status).toBe("UNDER_REVIEW")
  })

  it("the database refuses every shortcut to an attestation", async () => {
    const id = `dbguard-${t}`
    await seedUnderReview(ls.db(), ls.stack, id, { nca: false })
    const system = await ls.db().user.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, isSystem: true } })
    const version = (await ls.runOf((await ls.db().loanApplication.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, status: "APPROVED" } })).id)).ruleSetVersionId
    const terms = `status = 'APPROVED', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT', "approvedAt" = now()`
    const update = (set: string) => ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET ${set} WHERE id = '${id}'`)
    // With no provider the screening trigger is silent, so what speaks below is this guard.
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { screeningProvider: null } })
    const attest = `"automatedAffordabilityAttestedAt" = now(), "automatedAffordabilityVersionId" = '${version}'`
    // An engine approval with no attestation: what would otherwise approve a key-facts applicant with the setting off.
    await expect(update(`${terms}, "approvedById" = '${system.id}'`)).rejects.toThrow(/only on an automated affordability attestation/)
    // A person cannot claim it, and it cannot be half written.
    await expect(update(`${terms}, "approvedById" = '${ls.stack.officer}', ${attest}`)).rejects.toThrow(/not a person/)
    await expect(update(`${terms}, "approvedById" = '${ls.stack.officer}', "automatedAffordabilityVersionId" = '${version}'`)).rejects.toThrow(/LoanApplication_automated_affordability/)
    // No bureau check of this review: the standing decision.
    await expect(update(`${terms}, "approvedById" = '${system.id}', ${attest}`)).rejects.toThrow(/no bureau check of this review/)
    // Outside an approval it does not stand, and it is never there from the start.
    await expect(update(attest)).rejects.toThrow(/LoanApplication_automated_affordability|only with the engine/)
    const done = await ls.db().loanApplication.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, status: "APPROVED", automatedAffordabilityAttestedAt: { not: null } } })
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "automatedAffordabilityAttestedAt" = now() WHERE id = '${done.id}'`)).rejects.toThrow(/cannot be changed/)
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "automatedAffordabilityAttestedAt" = NULL, "automatedAffordabilityVersionId" = NULL WHERE id = '${done.id}'`)).rejects.toThrow(/cannot be changed/)
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { screeningProvider: "simulated" } })
  })

  it("the database refuses it when the setting has been withdrawn, whatever the code did", async () => {
    const id = `withdrawn-${t}`
    await seedUnderReview(ls.db(), ls.stack, id, { nca: false })
    const system = await ls.db().user.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, isSystem: true } })
    const approvedOne = await ls.db().loanApplication.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, automatedAffordabilityVersionId: { not: null } } })
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { screeningProvider: null } })
    expect((await ls.change(ENGINE_CONFIG_KIND, "off", ls.engine({ keyFactsInstantApproval: false, s71SignOff: true, automatedDeclineNotice: NOTICE }))).status).toBe(200)
    await expect(ls.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT', "approvedAt" = now(), "approvedById" = '${system.id}', "automatedAffordabilityAttestedAt" = now(), "automatedAffordabilityVersionId" = '${approvedOne.automatedAffordabilityVersionId}' WHERE id = '${id}'`)).rejects.toThrow(/instant key-facts approval setting is not on/)
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { screeningProvider: "simulated" } })
    expect((await ls.change(ENGINE_CONFIG_KIND, "back on", ls.engine({ keyFactsInstantApproval: true, s71SignOff: true, automatedDeclineNotice: NOTICE }))).status).toBe(200)
  })

  it("the approval matrix still applies: an engine approval that needs a person stays pending with staff, unattested", async () => {
    const matrix = { name: "People approve", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 1, rules: [], levels: [{ level: 1, name: "One", role: "LOAN_ADMIN", slaHours: 24, committee: false }] }
    expect((await ls.change(MATRIX_KIND, "matrix", matrix)).status).toBe(200)
    const clientId = `matrix-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    await ls.settled(id)
    expect(await ls.runOf(id)).toMatchObject({ verdict: "APPROVE", execution: "REFERRED", reasonCodes: expect.arrayContaining(["HARD_GATE_REFUSED"]) })
    expect(await ls.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", approvedById: null, automatedAffordabilityAttestedAt: null })
    expect((await ls.change(MATRIX_KIND, "matrix off", { ...matrix, enabled: false })).status).toBe(200)
  })

  it("an engine-approved loan pays out only through a second person, never to staff whose input it rests on, and a return to review clears the attestation", async () => {
    const flow = lsFlow(ls.db, ls.stack, holder)
    const clientId = `payout-${t}`
    await borrower(clientId)
    holder.hold = true
    const id = await ls.apply(clientId)
    // A staff member's input on the application: no person approved it, so that input takes the approver's place.
    await ls.db().loanApplication.update({ where: { id }, data: { inputStaffIds: [ls.stack.officer] } })
    await ls.release()
    expect(await ls.applicationOf(id)).toMatchObject({ status: "APPROVED" })

    await flow.attestKyc(id, clientId)
    await flow.issueAndSign(id, clientId, `${clientId}@test.invalid`)
    expect((await flow.verifyAccount(ls.stack.senior, id)).status).toBe(200)

    const refused = await flow.disburseAs(ls.stack.officer, id)
    expect(refused.status, JSON.stringify(await refused.clone().json())).toBe(422)
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("Segregation of duties") })
    expect((await ls.applicationOf(id)).status).toBe("APPROVED")

    const paid = await flow.disburseAs(ls.stack.disburser, id)
    expect(paid.status, JSON.stringify(await paid.clone().json())).toBe(200)
    expect(await ls.applicationOf(id)).toMatchObject({ status: "DISBURSED", disbursedById: ls.stack.disburser, disbursementRef: bankRefFor(id) })
    expect((await ls.applicationOf(id)).automatedAffordabilityAttestedAt).not.toBeNull()

    const clientTwo = `returned-${t}`
    await borrower(clientTwo)
    const returned = await ls.apply(clientTwo)
    await ls.settled(returned)
    expect((await ls.applicationOf(returned)).automatedAffordabilityAttestedAt).not.toBeNull()
    ls.as(ls.stack.officer, "LOAN_ADMIN")
    const form = new FormData()
    form.set("action", "return_to_review")
    form.set("reason", "The client asked us to look at the term again.")
    const back = await decideRoute(new NextRequest(`http://localhost/api/applications/${returned}/decide`, { method: "POST", body: form }), { params: Promise.resolve({ id: returned }) })
    expect(back.status, JSON.stringify(await back.clone().json())).toBe(200)
    expect(await ls.applicationOf(returned)).toMatchObject({ status: "UNDER_REVIEW", automatedAffordabilityAttestedAt: null, automatedAffordabilityVersionId: null })
  })
})

const za = harness("ZA")

suite("the same setting cannot be reached on a South African instance (real Postgres, real routes)", () => {
  beforeAll(async () => {
    await za.setup()
    expect((await za.change(RULE_SET_KIND, "rules", passingRules(null))).status).toBe(200)
    expect((await za.change(ENGINE_CONFIG_KIND, "live", za.engine({ channels: ["PORTAL", "STAFF"] }))).status).toBe(200)
  }, 300_000)
  afterAll(() => za.teardown(), 60_000)

  it("the settings route refuses it, naming the Act", async () => {
    const res = await za.change(ENGINE_CONFIG_KIND, "instant", za.engine({ keyFactsInstantApproval: true }))
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body)).toContain("National Credit Act")
    expect(await za.db().decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: za.stack.tenant } })).toMatchObject({ keyFactsInstantApproval: false })
  })

  it("the database refuses it even under an approved request that says so: the code's check is not the last word", async () => {
    const config = await za.db().decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: za.stack.tenant } })
    const copy = `forged-${t}`
    await za.db().$transaction([
      za.db().$executeRawUnsafe(`ALTER TABLE "ChangeRequest" DISABLE TRIGGER USER`),
      za.db().$executeRawUnsafe(`CREATE TEMP TABLE forged ON COMMIT DROP AS SELECT * FROM "ChangeRequest" WHERE id = '${config.changeRequestId}'`),
      za.db().$executeRawUnsafe(`UPDATE forged SET id = '${copy}', payload = payload || '{"keyFactsInstantApproval": true}'::jsonb`),
      za.db().$executeRawUnsafe(`INSERT INTO "ChangeRequest" SELECT * FROM forged`),
      za.db().$executeRawUnsafe(`ALTER TABLE "ChangeRequest" ENABLE TRIGGER USER`),
    ])
    await expect(za.db().$executeRawUnsafe(`UPDATE "DecisionEngineConfig" SET "keyFactsInstantApproval" = true, "changeRequestId" = '${copy}' WHERE "tenantId" = '${za.stack.tenant}'`)).rejects.toThrow(/National Credit Act/)
  })

  it("an NCA application cannot carry an attestation, approved or not", async () => {
    const id = `nca-stamp-${t}`
    await seedUnderReview(za.db(), za.stack, id, { nca: true })
    const version = (await za.db().decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: za.stack.tenant } })).id
    const stamp = `UPDATE "LoanApplication" SET "automatedAffordabilityAttestedAt" = now(), "automatedAffordabilityVersionId" = '${version}' WHERE id = '${id}'`
    await expect(za.db().$executeRawUnsafe(stamp)).rejects.toThrow(/only with the engine/)
    const system = await za.db().user.findFirstOrThrow({ where: { tenantId: za.stack.tenant, isSystem: true } })
    await za.db().tenantConfig.update({ where: { tenantId: za.stack.tenant }, data: { screeningProvider: null } })
    await expect(za.db().$executeRawUnsafe(`UPDATE "LoanApplication" SET status = 'APPROVED', "approvedAmount" = 500000, "approvedTermDays" = 30, "approvedRate" = 0.05, "repaymentMethod" = 'EFT', "approvedAt" = now(), "approvedById" = '${system.id}', "automatedAffordabilityAttestedAt" = now(), "automatedAffordabilityVersionId" = '${version}' WHERE id = '${id}'`)).rejects.toThrow(/setting is not on/)
    // With the guard out of the way the CHECK answers alone: two independent refusals.
    await za.db().$executeRawUnsafe(`ALTER TABLE "LoanApplication" DISABLE TRIGGER "LoanApplication_guard_automated_affordability"`)
    await expect(za.db().$executeRawUnsafe(stamp)).rejects.toThrow(/LoanApplication_automated_affordability/)
    await za.db().$executeRawUnsafe(`ALTER TABLE "LoanApplication" ENABLE TRIGGER "LoanApplication_guard_automated_affordability"`)
  })

  it("a client's digital application with a clean bureau report and passing rules still needs a person: the engine refers it for want of the s81 assessment", async () => {
    const clientId = `nca-digital-${t}`
    await seedDigitalBorrower(za.db(), za.stack, clientId, { files: holder.files, idNumber: cleanIdNumber(syntheticSaIdNumber), bank: { bankName: "Demo Bank", bankBranchCode: "250655" } })
    const id = await za.apply(clientId, za.stack.product, { affordabilityDeclared: true, pasqDeliveryUnderstood: true })
    await za.settled(id)
    expect(await za.runOf(id)).toMatchObject({ verdict: "APPROVE", execution: "REFERRED", reasonCodes: expect.arrayContaining(["HARD_GATE_REFUSED"]) })
    expect((await za.runOf(id)).executionNote).toMatch(/reckless-lending assessment/)
    expect(await za.applicationOf(id)).toMatchObject({ status: "UNDER_REVIEW", disclosureRegime: "NCA_PASQ", approvedById: null, recklessLendingAssessed: false, automatedAffordabilityAttestedAt: null })
  })

  it("the staff path ignores an attestation offered for an NCA application: it stamps nothing, and a person's assessment is what counts", async () => {
    const id = `nca-offered-${t}`
    const db = za.db()
    await seedUnderReview(db, za.stack, id, { nca: true })
    await clearOpenFlags(db, za.stack, id)
    const system = await db.user.findFirstOrThrow({ where: { tenantId: za.stack.tenant, isSystem: true } })
    const application = await za.applicationOf(id)
    const version = await db.decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: za.stack.tenant } })
    const form = new FormData()
    form.set("action", "approve")
    form.set("repaymentMethod", "EFT")
    const res = await runWithTenant(za.stack.tenant, () => decideApplication({
      tenant: { id: za.stack.tenant }, user: system, id, formData: form,
      automation: {
        ruleVersion: `ALL:v${version.version}`, ruleSetVersionId: version.id, reasonCodes: ["RULES_PASSED"], riskGrade: null, riskGradeRank: null, bureauCheckId: null, exactInputs: {},
        expectedUpdatedAt: application.updatedAt, attestsAffordability: true, inTransaction: async () => undefined,
      },
    }))
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect(await za.applicationOf(id)).toMatchObject({ status: "APPROVED", recklessLendingAssessed: true, automatedAffordabilityAttestedAt: null })
  })
})
