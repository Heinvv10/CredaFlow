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
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true, success: true, allowed: true }) }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
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

import { createAppPrismaClient, prisma } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { ENGINE_CONFIG_KIND, RULE_SET_KIND } from "@/lib/decisioning/change-payloads"
import { MATRIX_KIND } from "@/lib/approval/types"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "@/lib/non-nca-documents/gate.integration-fixture"
import { bankRefFor, lsFlow } from "@/lib/non-nca-documents/ls-flow.integration-fixture"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "@/lib/non-nca-documents/ls-stack.integration-fixture"
import { decideApplication } from "@/app/api/applications/[id]/decide/decide-application"
import { POST as decideRoute } from "@/app/api/applications/[id]/decide/route"
import { startApplicationReview } from "@/app/api/applications/[id]/review/review-application"
import { POST as portalApply } from "@/app/api/portal/applications/route"
import { PATCH as patchChange } from "@/app/api/maker-checker/[id]/route"
import { runAutoDecision } from "./auto-decision"
import { simulatedScenarioFor } from "@/lib/bureau/providers/simulated"

import { POST as websiteApply } from "@/app/api/website/apply/route"
import { POST as draftChange } from "@/app/api/maker-checker/route"
import { POST as actOnChange } from "@/app/api/maker-checker/[id]/[action]/route"
import { approveThroughStaffPath } from "./auto-actions"
import { cleanIdNumber, seedDigitalBorrower } from "./key-facts-instant.integration-fixture"
import { loadDecisionFacts } from "./load-facts"
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
const lesothoId0 = () => `99${String(randomInt(10_000_000)).padStart(7, "0")}`
const borrower = (id: string, over: { lastName?: string; income?: number } = {}) => seedDigitalBorrower(ls.db(), ls.stack, id, { files: holder.files, idNumber: lesothoId(), ...over })

/**
 * A digital application a person put under review (so it has its bureau check and no decision), and the staff path as the engine
 * would call it on a verdict it reached before the setting changed. `on` is the setting while the bureau check is made.
 */
async function reviewedByStaff(clientId: string, on: boolean) {
  await borrower(clientId)
  holder.hold = true
  const id = await ls.apply(clientId)
  holder.held = null
  holder.hold = false
  const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(ls.stack.tenant, fn)
  if (!on) expect((await ls.change(ENGINE_CONFIG_KIND, "on for the pull", ls.engine({ keyFactsInstantApproval: true, s71SignOff: true, automatedDeclineNotice: NOTICE }))).status).toBe(200)
  await inTenant(() => startApplicationReview({ tenant: { id: ls.stack.tenant }, user: { id: ls.stack.officer, email: "o@test.invalid" }, id, autoDecisionTrigger: "MANUAL" }))
  if (!on) expect((await ls.change(ENGINE_CONFIG_KIND, "withdrawn", ls.engine({ keyFactsInstantApproval: false, s71SignOff: true, automatedDeclineNotice: NOTICE }))).status).toBe(200)
  const version = await ls.db().decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, scopeKey: "ALL" } })
  const approve = () => inTenant(async () => {
    const loaded = (await loadDecisionFacts(prisma, ls.stack.tenant, id))!
    return approveThroughStaffPath({
      tenantId: ls.stack.tenant, applicationId: id, trigger: "DIGITAL_SUBMISSION", mode: "LIVE", role: "CHAMPION", loaded, attestsAffordability: true, startedAt: performance.now(), now: new Date(),
      version: { id: version.id, scopeKey: version.scopeKey, version: version.version },
      verdict: { decision: "APPROVE", reasonCodes: ["RULES_PASSED"], declineCategory: null, riskGrade: null, gradeRank: null, score: null, pricingTier: null, limitCapCents: null, hits: [] },
    }, "EFT")
  })
  return { id, approve }
}

const log = (label: string, v: unknown) => process.stdout.write(`[BRK] ${label}: ${JSON.stringify(v)}\n`)
const summary = async (id: string) => {
  const a = await ls.applicationOf(id)
  const r = await ls.db().autoDecisionRun.findFirst({ where: { applicationId: id }, orderBy: { createdAt: "desc" } })
  return { status: a.status, attested: a.automatedAffordabilityAttestedAt !== null, verdict: r?.verdict, exec: r?.execution, codes: r?.reasonCodes, note: r?.executionNote }
}

suite("BRK291 round 1", () => {
  beforeAll(async () => {
    await ls.setup()
    expect((await ls.change(RULE_SET_KIND, "rules", passingRules(null))).status).toBe(200)
    expect((await ls.change(ENGINE_CONFIG_KIND, "instant", ls.engine({ keyFactsInstantApproval: true }))).status).toBe(200)
  }, 300_000)
  afterAll(() => ls.teardown(), 60_000)
  beforeEach(async () => { await ls.db().autoDecisionDue.updateMany({ where: { tenantId: ls.stack.tenant }, data: { chargedAt: null } }) })


  it("P1 replay by deleting the row and inserting the old approval", async () => {
    expect((await ls.change(ENGINE_CONFIG_KIND, "on again", ls.engine({ keyFactsInstantApproval: true }))).status).toBe(200)
    const on = await ls.db().decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: ls.stack.tenant } })
    expect((await ls.change(ENGINE_CONFIG_KIND, "off", ls.engine({ keyFactsInstantApproval: false }))).status).toBe(200)
    const off = await ls.db().decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: ls.stack.tenant } })
    const bump = await ls.db().$executeRawUnsafe(`UPDATE "ChangeRequest" SET "decidedAt"=now() WHERE "id"='${on.changeRequestId}'`).then(() => "changed", (e) => `refused: ${String(e.message).slice(-90)}`)
    log("bump decidedAt", bump)
    const del = await ls.db().$executeRawUnsafe(`DELETE FROM "DecisionEngineConfig" WHERE "tenantId"='${ls.stack.tenant}'`).then(() => "deleted", (e) => `refused: ${String(e.message).slice(-90)}`)
    log("delete row", del)
    if (del === "deleted") {
      const ins = await ls.db().decisionEngineConfig.create({ data: { ...on, updatedAt: undefined } as never }).then(() => "reinserted old approval", (e) => `refused: ${String(e.message).slice(-90)}`)
      log("reinsert", ins)
      expect(ins).toMatch(/refused/)
    }
    expect(off.keyFactsInstantApproval).toBe(false)
    expect((await ls.change(ENGINE_CONFIG_KIND, "on", ls.engine({ keyFactsInstantApproval: true }))).status).toBe(200)
  })

  it("P2 legitimate changes keep working: back-to-back, around a withdrawn and a rejected one, s71 carried", async () => {
    const seq = [] as number[]
    for (const over of [{ keyFactsInstantApproval: false }, { keyFactsInstantApproval: true }, { keyFactsInstantApproval: true, s71SignOff: true, automatedDeclineNotice: NOTICE }, { keyFactsInstantApproval: false, s71SignOff: true, automatedDeclineNotice: NOTICE }, { mode: "SHADOW", keyFactsInstantApproval: false }, { mode: "OFF", keyFactsInstantApproval: false, channels: [], productIds: [] }, { keyFactsInstantApproval: true }]) {
      const r = await ls.change(ENGINE_CONFIG_KIND, "seq", ls.engine(over)); seq.push(r.status); if (r.status !== 200) log("seq body", r.body)
    }
    log("sequence", seq)
    expect(seq.every((c) => c === 200)).toBe(true)
  })

  it("P3 real concurrency: two products, both real digital tasks at once, the client can carry one", async () => {
    const base = await ls.db().loanProduct.findUniqueOrThrow({ where: { id: ls.stack.product } })
    const second = `${ls.stack.product}-c`
    await ls.db().loanProduct.create({ data: { ...base, id: second, code: `${base.code}-C`, createdAt: undefined, updatedAt: undefined } as never })
    expect((await ls.change(ENGINE_CONFIG_KIND, "both", ls.engine({ keyFactsInstantApproval: true, productIds: [ls.stack.product, second] }))).status).toBe(200)
    const out: unknown[] = []
    for (let round = 0; round < 6; round++) {
      const clientId = `cc${round}-${t}`
      await borrower(clientId)
      holder.hold = true
      const a = await ls.apply(clientId, ls.stack.product, { amount: 3000 }); const ha = holder.held!
      holder.held = null; holder.hold = true
      const b = await ls.apply(clientId, second, { amount: 3000 }); const hb = holder.held!
      holder.held = null; holder.hold = false
      const tasks: Promise<void>[] = []
      await Promise.all([ha, hb].map((h) => scheduleDigitalDecision(h, (run) => { tasks.push(run()) })))
      await Promise.all(tasks)
      await Promise.all([ls.settled(a), ls.settled(b)])
      const sa = await summary(a); const sb = await summary(b)
      out.push([sa.status, sa.attested, sb.status, sb.attested, sa.codes, sb.codes])
      await ls.db().autoDecisionDue.updateMany({ where: { tenantId: ls.stack.tenant }, data: { chargedAt: null } })
      expect(sa.attested && sb.attested).toBe(false)
    }
    log("concurrent", out)
  })

  it("no income evidence at all: no payslip and no statement on file", async () => {
    const clientId = `noinc-${t}`
    await borrower(clientId)
    await ls.db().clientDocument.deleteMany({ where: { clientId, docType: { in: ["PAYSLIP", "BANK_STATEMENT"] } } })
    const id = await ls.apply(clientId)
    await ls.settled(id)
    const s = await summary(id)
    log("no income evidence", s)
    expect(s.attested).toBe(false)
  })

  it("screening NOT_CONFIGURED refers, unattested", async () => {
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { screeningProvider: null } })
    const clientId = `nosc-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    await ls.settled(id)
    await ls.db().tenantConfig.update({ where: { tenantId: ls.stack.tenant }, data: { screeningProvider: "simulated" } })
    const s = await summary(id)
    log("screening off", s)
    expect(s.attested).toBe(false)
  })

  it("each adverse bureau scenario", async () => {
    for (const scenario of ["THIN_FILE", "ADVERSE_JUDGEMENT", "HIGH_DEBT"]) {
      const clientId = `sc-${scenario.slice(0, 4)}-${t}`
      let idNumber = ""
      for (;;) { idNumber = lesothoId0(); if (simulatedScenarioFor(idNumber) === scenario) break }
      await seedDigitalBorrower(ls.db(), ls.stack, clientId, { files: holder.files, idNumber })
      const id = await ls.apply(clientId)
      await ls.settled(id)
      const s = await summary(id)
      log(scenario, s)
      if (scenario !== "HIGH_DEBT") expect(s.attested).toBe(false)
    }
  })

  it("a stale bureau check: refer by the engine; and the DB trigger on the staff path", async () => {
    const { id, approve } = await reviewedByStaff(`stale-${t}`, true)
    await ls.db().creditBureauCheck.updateMany({ where: { applicationId: id }, data: { createdAt: new Date(Date.now() - 400 * 86_400_000) } })
    const out = await runAutoDecision({ tenantId: ls.stack.tenant, applicationId: id, trigger: "DIGITAL_SUBMISSION" })
    log("stale engine", { out, s: await summary(id) })
    expect((await summary(id)).attested).toBe(false)
    const done = await approve()
    log("stale forged ctx", { done, s: await summary(id) })
    expect((await summary(id)).attested).toBe(false)
  })

  it("matrix: a rule on ungraded applications requires a level", async () => {
    const matrix = { name: "Ungraded needs a person", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 0, rules: [{ id: "u", name: "Ungraded", when: { ungraded: true }, requiredLevels: 1 }], levels: [{ level: 1, name: "One", role: "LOAN_ADMIN", slaHours: 24, committee: false }] }
    expect((await ls.change(MATRIX_KIND, "matrix", matrix)).status).toBe(200)
    const clientId = `ungr-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    await ls.settled(id)
    const s = await summary(id)
    log("ungraded matrix", s)
    expect((await ls.change(MATRIX_KIND, "off", { ...matrix, enabled: false, effectiveFrom: "2026-01-02" })).status).toBe(200)
    expect(s.attested).toBe(false)
  })

  it("two products at once: neither run sees the other, combined unaffordable", async () => {
    const base = await ls.db().loanProduct.findUniqueOrThrow({ where: { id: ls.stack.product } })
    const second = `${ls.stack.product}-b`
    await ls.db().loanProduct.create({ data: { ...base, id: second, code: `${base.code}-B`, createdAt: undefined, updatedAt: undefined } as never })
    expect((await ls.change(ENGINE_CONFIG_KIND, "both", ls.engine({ keyFactsInstantApproval: true, productIds: [ls.stack.product, second] }))).status).toBe(200)
    const clientId = `race-${t}`
    await borrower(clientId)
    const amount = 3800
    holder.hold = true
    const a = await ls.apply(clientId, ls.stack.product, { amount })
    holder.held = null; holder.hold = true
    const b = await ls.apply(clientId, second, { amount })
    holder.held = null; holder.hold = false
    const version = await ls.db().decisionRuleSetVersion.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, scopeKey: "ALL" } })
    const system = await ls.db().user.findFirstOrThrow({ where: { tenantId: ls.stack.tenant, isSystem: true } })
    const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(ls.stack.tenant, fn)
    await inTenant(() => startApplicationReview({ tenant: { id: ls.stack.tenant }, user: { id: system.id, email: system.email }, id: a, autoDecisionTrigger: "MANUAL", assignToUser: false }))
    await inTenant(() => startApplicationReview({ tenant: { id: ls.stack.tenant }, user: { id: system.id, email: system.email }, id: b, autoDecisionTrigger: "MANUAL", assignToUser: false }))
    const ctxFor = async (id: string) => {
      const loaded = (await loadDecisionFacts(prisma, ls.stack.tenant, id))!
      return { tenantId: ls.stack.tenant, applicationId: id, trigger: "DIGITAL_SUBMISSION" as const, mode: "LIVE" as const, role: "CHAMPION" as const, loaded, attestsAffordability: true, startedAt: performance.now(), now: new Date(),
        version: { id: version.id, scopeKey: version.scopeKey, version: version.version },
        verdict: { decision: "APPROVE" as const, reasonCodes: ["RULES_PASSED"], declineCategory: null, riskGrade: null, gradeRank: null, score: null, pricingTier: null, limitCapCents: null, hits: [] } }
    }
    // Both read their facts first, as two concurrent after-response tasks do.
    const [ca, cb] = await inTenant(() => Promise.all([ctxFor(a), ctxFor(b)]))
    log("facts", [ca.loaded.facts.ndiCents, ca.loaded.facts.instalmentCents, ca.loaded.facts.ndiCoverPct, ca.loaded.facts.affordabilityGatePasses, cb.loaded.facts.affordabilityGatePasses])
    const ra = await inTenant(() => approveThroughStaffPath(ca as never, "EFT"))
    const rb = await inTenant(() => approveThroughStaffPath(cb as never, "EFT"))
    log("A", { ra, s: await summary(a) }); log("B", { rb, s: await summary(b) })
    const reread = await inTenant(() => loadDecisionFacts(prisma, ls.stack.tenant, b))
    const rowA = await ls.applicationOf(a); const snap = (rowA.affordabilityResult as { approval?: { inputs?: object; debts?: object } })?.approval
    log("A approval inputs", snap?.inputs); log("A debts", snap?.debts)
    const rowB = await ls.applicationOf(b); const snapB = (rowB.affordabilityResult as { approval?: { inputs?: object; debts?: object; outcome?: object } })?.approval
    log("B approval inputs", snapB?.inputs); log("B debts", snapB?.debts); log("B outcome", snapB?.outcome)
    log("schedule", [rowA.approvedAmount, rowA.approvedTermDays, rowB.approvedAmount])
    log("B after A", [reread?.facts.ndiCents, reread?.facts.ndiCoverPct, reread?.facts.affordabilityGatePasses])
    expect((await ls.applicationOf(a)).automatedAffordabilityAttestedAt !== null && (await ls.applicationOf(b)).automatedAffordabilityAttestedAt !== null).toBe(false)
  })

  it("the public website form, no session, email and ID only", async () => {
    const clientId = `web-${t}`
    await borrower(clientId)
    const client = await ls.db().client.findUniqueOrThrow({ where: { id: clientId } })
    const product = await ls.db().loanProduct.findUniqueOrThrow({ where: { id: ls.stack.product } })
    const res = await websiteApply(new NextRequest("http://localhost/api/website/apply", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({
      firstName: client.firstName, lastName: client.lastName, email: client.email, phone: client.phone, idNumber: client.idNumber, productType: product.productType, amount: 5000, termDays: 30, purpose: "Other", turnstileToken: "x", popiaConsent: true,
    }) }))
    const body = await res.json()
    log("website", { status: res.status, body })
    const app = await ls.db().loanApplication.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } })
    if (app) { await ls.settled(app.id).catch((e) => log("settle", String(e))); const s = await summary(app.id); log("website run", s); log("flags", await ls.db().applicationCheckFlag.findMany({ where: { applicationId: app.id, status: "OPEN" }, select: { check: true, code: true } })); log("portal flags", await ls.db().applicationCheckFlag.count({ where: { tenantId: ls.stack.tenant, status: "OPEN", code: "x" } })); expect(s.attested).toBe(false) }
  })

  it("the setting: self approval, a LOAN_ADMIN maker, a draft edited to on, SHADOW", async () => {
    // SUPER_ADMIN drafts and approves their own.
    const self = await ls.change(ENGINE_CONFIG_KIND, "self", ls.engine({ keyFactsInstantApproval: true, challengerPercent: 0, repaymentMethod: "EFT", channels: ["PORTAL"] }), { id: ls.maker, role: "SUPER_ADMIN" })
    log("self approve", { status: self.status, body: self.body })
    expect(self.status).not.toBe(200)
    await ls.withdraw(self.id!)
    // A LOAN_ADMIN may make plain drafts, not this one.
    ls.as(ls.stack.officer, "LOAN_ADMIN")
    const d = await draftChange(new NextRequest("http://localhost/api/maker-checker", { method: "POST", body: JSON.stringify({ kind: ENGINE_CONFIG_KIND, title: "t", payload: ls.engine({ mode: "SHADOW", keyFactsInstantApproval: true }) }) }))
    log("loan admin draft on", d.status); expect(d.status).toBe(403)
    const d2 = await draftChange(new NextRequest("http://localhost/api/maker-checker", { method: "POST", body: JSON.stringify({ kind: ENGINE_CONFIG_KIND, title: "t", payload: ls.engine({ mode: "SHADOW", keyFactsInstantApproval: false }) }) }))
    const b2 = await d2.json(); log("loan admin draft off", d2.status)
    const e = await patchChange(new NextRequest(`http://localhost/api/maker-checker/${b2.request.id}`, { method: "PATCH", body: JSON.stringify({ payload: ls.engine({ mode: "SHADOW", keyFactsInstantApproval: true }) }) }), { params: Promise.resolve({ id: b2.request.id }) })
    log("loan admin edit on", e.status); expect(e.status).toBe(403)
    // SHADOW, on: no bureau pull, nothing moves.
    expect((await ls.change(ENGINE_CONFIG_KIND, "shadow", ls.engine({ mode: "SHADOW", keyFactsInstantApproval: true }))).status).toBe(200)
    const clientId = `shad-${t}`
    await borrower(clientId)
    const id = await ls.apply(clientId)
    await ls.settled(id)
    const s = await summary(id)
    log("shadow", { s, pulls: await ls.db().creditBureauCheck.count({ where: { applicationId: id } }) })
    expect(s.status).toBe("SUBMITTED"); expect(s.attested).toBe(false)
    expect((await ls.change(ENGINE_CONFIG_KIND, "back", ls.engine({ keyFactsInstantApproval: true }))).status).toBe(200)
  })

  it("forged maker-checker on Lesotho: an APPROVED row where maker is checker, and a replay of an old approval", async () => {
    const insert = (id: string, payload: object) => ls.db().$executeRawUnsafe(
      `INSERT INTO "ChangeRequest" ("id","tenantId","kind","title","payload","payloadVersion","status","makerId","checkerId","decidedAt","appliedAt","updatedAt") VALUES ($1,$2,'DECISION_ENGINE_CONFIG','forged',$3::jsonb,1,'APPROVED',$4,$4,now(),now(),now())`,
      id, ls.stack.tenant, JSON.stringify(payload), ls.maker)
    const forged = await insert(`forged-${t}`, ls.engine({ keyFactsInstantApproval: true })).then(() => "inserted", (e) => `refused: ${String(e.message).slice(-160)}`)
    log("forged CR", forged)
    expect(forged).toMatch(/refused/)
    // Off by an approved change; the row pointed back at the old approval that said on.
    const on = await ls.db().decisionEngineConfig.findUniqueOrThrow({ where: { tenantId: ls.stack.tenant } })
    expect((await ls.change(ENGINE_CONFIG_KIND, "off", ls.engine({ keyFactsInstantApproval: false }))).status).toBe(200)
    const replay = await ls.db().$executeRawUnsafe(`UPDATE "DecisionEngineConfig" SET "changeRequestId" = '${on.changeRequestId}', "keyFactsInstantApproval" = true WHERE "tenantId" = '${ls.stack.tenant}'`).then(() => "applied", (e) => `refused: ${String(e.message).slice(-120)}`)
    log("replay", replay)
    expect(replay).toMatch(/refused/)
  })
})

const flip = harness("LS")
suite("BRK291 jurisdiction change", () => {
  beforeAll(async () => {
    await flip.setup()
    expect((await flip.change(RULE_SET_KIND, "rules", passingRules(null))).status).toBe(200)
    expect((await flip.change(ENGINE_CONFIG_KIND, "instant", flip.engine({ keyFactsInstantApproval: true }))).status).toBe(200)
  }, 300_000)
  afterAll(() => flip.teardown(), 60_000)
  it("an instance with the setting on cannot become South African", async () => {
    const out = await flip.db().$executeRawUnsafe(`UPDATE "InstanceJurisdiction" SET "jurisdiction"='ZA', "currency"='ZAR' WHERE "id"=1`).then(() => "changed", (e) => `refused: ${String(e.message).slice(-160)}`)
    log("flip", out)
    expect(out).toMatch(/refused/)
  })
})
