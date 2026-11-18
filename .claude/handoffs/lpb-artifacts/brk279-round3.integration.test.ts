/**
 * Breaker round 3 on PR #279 (head c23fdb2e): repros against real Postgres, real routes. Each test asserts what was OBSERVED and logs it.
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run lib/non-nca-documents/brk279-round3.integration.test.ts --testTimeout=60000 --hookTimeout=120000
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>() }))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, { get(_t, key) { if (!holder.app) throw new Error("no client"); const v: unknown = Reflect.get(holder.app, key); return typeof v === "function" ? v.bind(holder.app) : v } })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true } })) }))
vi.mock("@/lib/auth-guards", async (o) => ({
  ...(await o<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({ user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true } })),
}))
vi.mock("@/lib/tenant", async (o) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return { ...(await o<typeof import("@/lib/tenant")>()), withTenantContext: (_r: unknown, h: (t: object) => Promise<unknown>) => runWithTenant(holder.tenantId, () => h({ id: holder.tenantId, slug: holder.tenantId, name: "brk", domain: null, status: "ACTIVE" })) }
})
vi.mock("@/lib/notifications", async (o) => ({ ...(await o<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/storage", () => ({
  saveFile: async (b: Buffer) => { const p = `/mem/${holder.files.size}.pdf`; holder.files.set(p, b); return { storagePath: p, fileSize: b.length } },
  readFile: async (p: string) => { const b = holder.files.get(p); if (!b) throw new Error("missing"); return b },
  deleteFile: async (p: string) => { holder.files.delete(p) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (h: string) => Buffer.from(`%PDF-synthetic ${h} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (o) => ({ ...(await o<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { runWithTenant } from "@/lib/tenant-scope"
import { GET as payoutCheck } from "@/app/api/applications/[id]/payout-check/route"
import { PUT as clientPut } from "@/app/api/clients/[id]/route"
import { acknowledgeKeyFacts } from "./acknowledge"
import { issueLoanDocuments } from "./issue"
import { signKeyFactsAgreement } from "./sign"
import { loanDocumentState } from "./state"
import { affordabilityDecisionFingerprint, affordabilityInputFingerprint } from "@/lib/affordability/snapshot"
import { POST as paymentsRoute } from "@/app/api/payments/route"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "./gate.integration-fixture"
import { BANK_REF, lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, PRODUCT, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const J = (process.env.BRK_J ?? "LS") as "LS" | "ZA"
const stack = stackOf(J, t)
const role = `cf_brk_${t}`
const BODY = (x: string) => `<h1>${x}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const { approvedApplication, as, attestKyc, decideForm, disburseAs, issueAndSign, verifyAccount, signedApplication } = lsFlow(db, stack, holder)
const stack2 = stackOf(J, `${t}b`)
const flow2 = lsFlow(db, stack2, holder)
const check = (id: string) => payoutCheck(new NextRequest(`http://localhost/api/applications/${id}/payout-check`), { params: Promise.resolve({ id }) })
const put = async (cid: string, data: object) => {
  as(stack.officer, "CREDIT_OFFICER")
  const updated = (await db().client.findUniqueOrThrow({ where: { id: cid } })).updatedAt.toISOString()
  return clientPut(new NextRequest(`http://localhost/api/clients/${cid}`, { method: "PUT", body: JSON.stringify({ ...data, expectedUpdatedAt: updated }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: cid }) })
}
const j = (r: Response) => r.clone().json().catch(() => null)
const say = (...a: unknown[]) => process.stdout.write(`[BRK] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`)

suite("brk279 round 3", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb(J === "LS" ? { instance: { jurisdiction: "LS", currency: "LSL" } } : {})
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "BRK", isDemoLender: true })
    await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: {
      ...VALID_LENDER_COLUMNS, legalName: "Demo Basotho Lending (Pty) Ltd", brandName: "Demo Basotho Lending", ...(J === "LS" ? { ncrNumber: null, fscaNumber: null } : {}),
      ...(J === "LS" ? { companyRegNumber: "2099/000001", registeredOffice: "1 Demo Road\nMaseru\n100", publicPhone: "+266 2200 0000", collectionsPhone: "+266 2200 0001" } : {}),
    } as never })
    await createTemplate(db(), stack.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    await seedStack(db(), stack2, { code: "BRL", isDemoLender: true })
    await createTemplate(db(), stack2.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack2.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient((await createRlsRole(db(), fresh.url, role)).replace("connection_limit=1", "connection_limit=8"))
    holder.app = app
    resetActiveJurisdiction(); resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)
  afterAll(async () => {
    vi.unstubAllEnvs(); holder.app = null; await app?.$disconnect()
    await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
    await fresh?.drop()
    const admin = new PrismaClient(); await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); await admin.$disconnect()
    resetActiveJurisdiction(); resetEnsuredJurisdiction()
  }, 60_000)

  const replica = (fn: (tx: PrismaClient) => Promise<unknown>) => db().$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`); await fn(tx as never) })
  const rule = (id: string, over: object, tenantId = stack.tenant, productId: string = stack.product) => replica((tx) => tx.productPricingRule.create({ data: { id, tenantId, productId, name: `R ${id}`, validFrom: new Date("2020-01-01"), rateMode: "SET", rateValue: 0.04, changeRequestId: `cr-${id}`, ...over } as never }))
  const clearRules = () => replica((tx) => tx.productPricingRule.deleteMany({ where: { tenantId: stack.tenant } }))
  const seedIt = async (id: string) => {
    const { statement } = await seedUnderReview(db(), stack, id, { nca: J === "ZA" })
    holder.files.set(statement.path, statement.bytes)
    await clearOpenFlags(db(), stack, id)
  }
  const approveNow = async (id: string, label: string) => {
    const r = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    const row = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const inputs = (row.affordabilityResult as { approval?: { inputs: Record<string, unknown>; calculator: { initiationFeeCents: number } } }).approval
    say(label, r.status, r.status === 200 ? { rate: inputs?.inputs.interestRatePm, feePct: inputs?.inputs.initiationFeePct, feeCents: inputs?.calculator.initiationFeeCents, rule: (inputs?.inputs.productVersion as { pricingRuleId?: string })?.pricingRuleId ?? null } : JSON.stringify(await j(r)).slice(0, 220))
    return r.status
  }

  it("G: function, trigger", async () => {
    const [f] = await db().$queryRawUnsafe<{ d: string; sec: boolean; cfg: string[] | null }[]>(`SELECT pg_get_functiondef(p.oid) d, p.prosecdef sec, p.proconfig cfg FROM pg_proc p WHERE proname = 'guardSignedDebitMandateAuthority'`)
    const trg = await db().$queryRawUnsafe<{ tgname: string; tgenabled: string }[]>(`SELECT tgname, tgenabled::text FROM pg_trigger WHERE tgfoid = 'public."guardSignedDebitMandateAuthority"()'::regprocedure`)
    say("G", { len: f.d.length, sec: f.sec, cfg: f.cfg, rateClause: (f.d.match(/ProductPricingRule/g) ?? []).length, oldRateLeft: (f.d.match(/AND new_approval #>> '\{inputs,interestRatePm\}'\n/g) ?? []).length, retired: /retiredAt|validTo/.test(f.d) }, trg)
    let i = -1; const hits: string[] = []
    while ((i = f.d.indexOf("{inputs,interestRatePm}", i + 1)) >= 0) hits.push(f.d.slice(Math.max(0, i - 90), i + 130).replace(/\s+/g, " "))
    say("G hits", hits)
    say("G rule", f.d.slice(f.d.indexOf("ProductPricingRule") - 240, f.d.indexOf("ProductPricingRule") + 240).replace(/\s+/g, " "))
  })

  it("Rt: real decide", async () => {
    await replica((tx) => tx.productVersion.create({ data: { tenantId: stack.tenant, productId: stack.product, version: 1, effectiveFrom: new Date("2020-01-01"), minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6900, collateral: [], eligibility: {}, reason: "Synthetic", changeRequestId: `cr-v-${t}` } as never }))
    const cases: Array<[string, object]> = [["valid 0.04", {}], ["over cap 0.06", { rateValue: 0.06 }], ["fee 0.5", { initiationFeePct: 0.5 }], ["expired", { validTo: new Date("2021-01-01") }], ["retired", { retiredAt: new Date(), retiredByRequestId: `crr-${Math.random()}` }]]
    for (const [i, [name, over]] of cases.entries()) {
      await clearRules(); await rule(`rt${i}-${t}`, over)
      const id = `rt${i}-${t}`
      await seedIt(id)
      await approveNow(id, `Rt ${J} ${name}`)
    }
    await clearRules()
  })

  it("Db: direct installs", async () => {
    await rule(`good-${t}`, {})
    await rule(`dead-${t}`, { validTo: new Date("2021-01-01"), retiredAt: new Date(), retiredByRequestId: `crr-${Math.random()}` })
    await db().loanProduct.create({ data: { id: `${stack.product}-o`, tenantId: stack.tenant, code: `O-${t}`, name: "Other", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...PRODUCT } })
    await rule(`prod-${t}`, {}, stack.tenant, `${stack.product}-o`)
    await rule(`ten-${t}`, {}, stack2.tenant, stack2.product)
    const id = `db-${t}`
    await seedIt(id)
    expect(await approveNow(id, "Db base")).toBe(200)
    const saved = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const back = await decideForm(id, { action: "return_to_review", reason: "Synthetic: breaker returns it to review." })
    say("Db back", back.status)
    const cols = ["approvedAmount", "approvedTermDays", "approvedById", "approvedAt", "repaymentMethod", "netDisposableIncome", "affordabilityNDI", "totalExistingDebt", "riskGrade", "riskScore", "submittedAt"] as const
    const data = Object.fromEntries(cols.map((c) => [c, (saved as never as Record<string, unknown>)[c]]))
    const attempt = async (label: string, mutate: (a: Record<string, never> & { inputs: Record<string, unknown> }) => void) => {
      const current = await db().loanApplication.findUniqueOrThrow({ where: { id } })
      const store = JSON.parse(JSON.stringify(saved.affordabilityResult)) as { approval: Record<string, never> & { inputs: Record<string, unknown>; stage: never; policyVersion: never; capturedAt: never; capturedById: never; expenses: never; debts: { application: never; client: never }; bureauEvidence: never; calculator: never; outcome: never; inputFingerprint: string; decisionFingerprint: string } }
      const a = store.approval
      mutate(a as never)
      a.inputFingerprint = affordabilityInputFingerprint(a.inputs as never)
      a.decisionFingerprint = affordabilityDecisionFingerprint({ stage: a.stage, policyVersion: a.policyVersion, capturedAt: a.capturedAt, capturedById: a.capturedById, inputs: a.inputs as never, expenses: a.expenses, applicationDebts: a.debts.application, clientDebts: a.debts.client, bureauEvidence: a.bureauEvidence, calculator: a.calculator, outcome: a.outcome })
      const res = await db().$transaction(async (tx) => {
        await tx.loanApplication.update({ where: { id }, data: { ...data, approvedRate: a.inputs.interestRatePm, status: "APPROVED", affordabilityResult: { ...(current.affordabilityResult as object), approval: store.approval } as object } as never })
        throw new Error("ROLLBACK-OK")
      }).then(() => "?", (e: Error) => e.message === "ROLLBACK-OK" ? "ACCEPTED" : `refused: ${(/message: "([^"]+)"/.exec(e.message)?.[1] ?? e.message.slice(-120))}`)
      say("Db", J, label, res)
    }
    const pv = (over: object) => (a: { inputs: Record<string, unknown> }) => { a.inputs.productVersion = { ...(a.inputs.productVersion as object), ...over } }
    await attempt("control unchanged", () => undefined)
    await attempt("rate 0.5, valid rule", (a) => { a.inputs.interestRatePm = 0.5 })
    await attempt("rate 0.03, no rule", (a) => { a.inputs.interestRatePm = 0.03; pv({ pricingRuleId: null })(a) })
    await attempt("rate 0.03, no version", (a) => { a.inputs.interestRatePm = 0.03; delete a.inputs.productVersion })
    await attempt("rate 0.03, other product rule", (a) => { a.inputs.interestRatePm = 0.03; pv({ pricingRuleId: `prod-${t}` })(a) })
    await attempt("rate 0.03, other tenant rule", (a) => { a.inputs.interestRatePm = 0.03; pv({ pricingRuleId: `ten-${t}` })(a) })
    await attempt("rate 0.03, expired+retired rule", (a) => { a.inputs.interestRatePm = 0.03; pv({ pricingRuleId: `dead-${t}` })(a) })
    await attempt("rate 0.03, base off row", (a) => { a.inputs.interestRatePm = 0.03; pv({ baseRatePm: 0.09 })(a) })
    await attempt("fee 0.9, valid rule no fee", (a) => { a.inputs.initiationFeePct = 0.9 })
    await rule(`over-${t}`, { rateValue: 0.06 })
    await attempt("rate 0.06, SET 0.06 rule (over ZA cap)", (a) => { a.inputs.interestRatePm = 0.06; pv({ pricingRuleId: `over-${t}` })(a) })
    await rule(`add-${t}`, { rateMode: "ADD", rateValue: -0.01 })
    await attempt("rate 0.04, ADD -0.01 rule", (a) => { pv({ pricingRuleId: `add-${t}` })(a) })
    await attempt("rate 0.03, ADD -0.01 rule", (a) => { a.inputs.interestRatePm = 0.03; pv({ pricingRuleId: `add-${t}` })(a) })
    await replica((tx) => tx.productPricingRule.create({ data: { id: `glob-${t}`, tenantId: stack.tenant, productId: null, name: "G", validFrom: new Date("2020-01-01"), rateMode: "SET", rateValue: 0.035, changeRequestId: `cr-g-${t}` } as never }))
    await attempt("rate 0.035, global rule", (a) => { a.inputs.interestRatePm = 0.035; pv({ pricingRuleId: `glob-${t}` })(a) })
    await rule(`fut-${t}`, { validFrom: new Date("2099-01-01"), rateValue: 0.03 })
    await attempt("rate 0.03, future rule", (a) => { a.inputs.interestRatePm = 0.03; pv({ pricingRuleId: `fut-${t}` })(a) })
  })

  it("N: ncaRatePmAllowed against the code", async () => {
    const { checkNcaInterestRate, ncaCreditType } = await import("@/lib/loan/nca-interest-cap")
    const row = (repo: number | null) => repo === null ? Promise.resolve() : replica((tx) => tx.referenceRate.create({ data: { tenantId: stack.tenant, basis: "REPO", effectiveDate: new Date("2024-01-01"), rate: repo, status: "APPROVED", requestedById: stack.officer, decidedById: stack.senior, decidedAt: new Date() } as never }))
    let diffs = 0, n = 0
    const sql = async (p: number, d: number, r: number, m: string) => (await db().$queryRawUnsafe<{ a: boolean }[]>(`SELECT public."ncaRatePmAllowed"($1::text, $2::int, $3::int, $4::float8, $5::text) a`, stack.tenant, p, d, r, m))[0].a
    for (const repo of [null, 0.0675]) {
      await row(repo)
      for (const [p, d] of [[500_000, 30], [800_000, 180], [800_001, 180], [800_000, 181], [5_000_000, 720]]) for (const m of ["REDUCING_BALANCE", "FLAT", "DAILY_ACCRUAL"]) for (const r of [0.01, 0.0233, 0.0229, 0.0231, 0.0225, 0.0223, 0.05, 0.050000001, 0.06]) {
        const js = checkNcaInterestRate({ creditType: ncaCreditType(p, d), interestRatePm: r, interestModel: m, repoAnnualRate: repo }).ok
        const s = await sql(p, d, r, m)
        n++
        if (js !== s) { diffs++; say("N diff", { repo, p, d, m, r, js, sql: s }) }
      }
    }
    say("N grid", n, "diffs", diffs)
    await replica((tx) => tx.referenceRate.create({ data: { tenantId: stack.tenant, basis: "REPO", effectiveDate: new Date("2099-01-01"), rate: 0.5, status: "APPROVED", requestedById: stack.officer, decidedById: stack.senior, decidedAt: new Date() } as never }))
    await replica((tx) => tx.referenceRate.create({ data: { tenantId: stack.tenant, basis: "REPO", effectiveDate: new Date("2024-06-01"), rate: 0.5, status: "PENDING" } as never }))
    say("N future/pending repo ignored", (await sql(5_000_000, 720, 0.06, "REDUCING_BALANCE")) === false)
    await replica((tx) => tx.referenceRate.create({ data: { tenantId: stack.tenant, basis: "REPO", effectiveDate: new Date("2024-07-01"), rate: 0.5, status: "APPROVED", requestedById: stack.officer, decidedById: stack.senior, decidedAt: new Date() } as never }))
    say("N implausible approved repo 50%: sql allows 6%pm", await sql(5_000_000, 720, 0.06, "REDUCING_BALANCE"), "(code refuses REPO_IMPLAUSIBLE)")
  })

  it("S: sign and ref", async () => {
    if (J !== "LS") return
    const { manualBankRef } = await import("./payout-terms")
    say("S ref", ["TX-777  A", "ＴＸ-777 A", "TX-777 A", " tx-777 a ", "TX777A", "​", "a\nb", "ﬀ1", " ".repeat(500) + "A"].map((x) => manualBankRef(x)))
    const [a, b, c] = [`sa-${t}`, `sb-${t}`, `sc-${t}`]
    await clearRules(); await replica((tx) => tx.productVersion.deleteMany({ where: { tenantId: stack.tenant } }))
    await signedApplication(a); await signedApplication(b); await signedApplication(c)
    expect((await disburseAs(stack.disburser, a, { bankRef: "TX-777 A" })).status).toBe(200)
    const dup = await disburseAs(stack.disburser, b, { bankRef: "ｔｘ-777   a" })
    say("S dup variant", dup.status, (await j(dup))?.disbursementPrecondition)
    const id = `si-${t}`
    await approvedApplication(id)
    const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(stack.tenant, fn)
    expect(await inTenant(() => issueLoanDocuments({ tenantId: stack.tenant, applicationId: id, staff: { id: stack.officer, email: "o@test.invalid" } }))).toMatchObject({ ok: true })
    const docs = (await inTenant(() => loanDocumentState(stack.tenant, id)))!.keyFacts!.documents
    const base = { tenantId: stack.tenant, applicationId: id, clientId: `${id}-client`, clientEmail: `${id}@test.invalid` }
    expect(await inTenant(() => acknowledgeKeyFacts({ ...base, shown: docs.find((d) => d.kind === "KEY_FACTS_STATEMENT")!.pdfSha256 }))).toMatchObject({ ok: true })
    expect((await put(`${id}-client`, { lastName: "Changedafterack" })).status).toBe(200)
    const sig = await inTenant(() => signKeyFactsAgreement({ ...base, agreementDocumentSha256: docs.find((d) => d.kind === "LOAN_AGREEMENT")!.pdfSha256, signature: "Synthetic Borrower", signingOtpChallengeId: null, ipAddress: "203.0.113.9" }))
    say("S sign after change", sig)
    expect((await put(`${id}-client`, { lastName: "Borrower" })).status).toBe(200)
    const sig2 = await inTenant(() => signKeyFactsAgreement({ ...base, agreementDocumentSha256: docs.find((d) => d.kind === "LOAN_AGREEMENT")!.pdfSha256, signature: "Synthetic Borrower", signingOtpChallengeId: null, ipAddress: "203.0.113.9" }))
    say("S sign restored", sig2)
  })
})
