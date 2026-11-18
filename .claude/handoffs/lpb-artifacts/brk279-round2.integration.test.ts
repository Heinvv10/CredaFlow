/**
 * Breaker round 2 on PR #279 (head 783d5825): repros against real Postgres, real routes. Each test asserts what was OBSERVED and logs it.
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run lib/non-nca-documents/brk279-round2.integration.test.ts --testTimeout=60000 --hookTimeout=120000
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
import { runScreening } from "@/lib/screening/run"
import { affordabilityInputFingerprint, createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { STRUCTURED_SCHEDULE_CHANNEL } from "@/lib/product-engine/channels"
import { PRODUCT_VERSION_KIND } from "@/lib/product-engine/change-handlers"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { loadSourceLoans } from "@/lib/accounting/store"
import { loanSources } from "@/lib/accounting/sources"
import { POST as paymentsRoute } from "@/app/api/payments/route"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "./gate.integration-fixture"
import { BANK_REF, lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, PRODUCT, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_brk_${t}`
const BODY = (x: string) => `<h1>${x}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const { approvedApplication, as, attestKyc, decideForm, disburseAs, issueAndSign, verifyAccount, signedApplication } = lsFlow(db, stack, holder)
const stack2 = stackOf("LS", `${t}b`)
const flow2 = lsFlow(db, stack2, holder)
const check = (id: string) => payoutCheck(new NextRequest(`http://localhost/api/applications/${id}/payout-check`), { params: Promise.resolve({ id }) })
const put = async (cid: string, data: object) => {
  as(stack.officer, "CREDIT_OFFICER")
  const updated = (await db().client.findUniqueOrThrow({ where: { id: cid } })).updatedAt.toISOString()
  return clientPut(new NextRequest(`http://localhost/api/clients/${cid}`, { method: "PUT", body: JSON.stringify({ ...data, expectedUpdatedAt: updated }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: cid }) })
}
const j = (r: Response) => r.clone().json().catch(() => null)
const say = (...a: unknown[]) => process.stdout.write(`[BRK] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`)

suite("brk279 round 2", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "BRK", isDemoLender: true })
    await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: {
      ...VALID_LENDER_COLUMNS, legalName: "Demo Basotho Lending (Pty) Ltd", brandName: "Demo Basotho Lending", ncrNumber: null, fscaNumber: null,
      companyRegNumber: "2099/000001", registeredOffice: "1 Demo Road\nMaseru\n100", publicPhone: "+266 2200 0000", collectionsPhone: "+266 2200 0001",
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

  const LS_ID = () => `99${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`

  it("R1: round 1 B, C, D", async () => {
    const [a, b, c] = [`r1a-${t}`, `r1b-${t}`, `r1c-${t}`]
    await signedApplication(a); await signedApplication(b); await signedApplication(c)
    expect((await disburseAs(stack.disburser, a, { bankRef: "SAME-REF-1" })).status).toBe(200)
    const dup = await disburseAs(stack.disburser, b, { bankRef: "SAME-REF-1" })
    say("R1 B", dup.status, (await j(dup))?.disbursementPrecondition)
    const zw = await disburseAs(stack.disburser, c, { bankRef: "​" })
    say("R1 C", zw.status, (await j(zw))?.disbursementPrecondition)
    const d = `r1d-${t}`
    await signedApplication(d)
    expect((await put(`${d}-client`, { lastName: "Someoneelse", idNumber: LS_ID() })).status).toBe(200)
    await attestKyc(d)
    await runWithTenant(stack.tenant, () => runScreening({ tenantId: stack.tenant, subject: { kind: "CLIENT", clientId: `${d}-client` } as never, trigger: "MANUAL" as never, applicationId: d, actor: { id: stack.officer, email: "o@test.invalid" } }))
    await verifyAccount(stack.officer, d)
    const res = await disburseAs(stack.disburser, d)
    say("R1 D", res.status, await j(res))
    expect(res.status).toBe(422)
  })

  it("I1: DOB alone, then first name case and spacing", async () => {
    const id = `dob-${t}`
    await signedApplication(id)
    const p = await put(`${id}-client`, { dateOfBirth: "1990-03-04" })
    say("I1 put", p.status, p.status === 200 ? "" : await j(p))
    await attestKyc(id)
    await runWithTenant(stack.tenant, () => runScreening({ tenantId: stack.tenant, subject: { kind: "CLIENT", clientId: `${id}-client` } as never, trigger: "MANUAL" as never, applicationId: id, actor: { id: stack.officer, email: "o@test.invalid" } }))
    await verifyAccount(stack.officer, id)
    as(stack.disburser)
    const c = await check(id)
    const r = await disburseAs(stack.disburser, id)
    say("I1 dry", await j(c), "real", r.status, (await j(r))?.disbursementPrecondition, (await j(r))?.affordabilitySnapshot)
  })

  it("I2: identity changed between issue and sign", async () => {
    const id = `iss-${t}`
    await approvedApplication(id)
    const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(stack.tenant, fn)
    expect(await inTenant(() => issueLoanDocuments({ tenantId: stack.tenant, applicationId: id, staff: { id: stack.officer, email: "o@test.invalid" } }))).toMatchObject({ ok: true })
    expect((await put(`${id}-client`, { lastName: "Changedafterissue", idNumber: LS_ID() })).status).toBe(200)
    const docs = (await inTenant(() => loanDocumentState(stack.tenant, id)))!.keyFacts!.documents
    const base = { tenantId: stack.tenant, applicationId: id, clientId: `${id}-client`, clientEmail: `${id}@test.invalid` }
    const ack = await inTenant(() => acknowledgeKeyFacts({ ...base, shown: docs.find((d) => d.kind === "KEY_FACTS_STATEMENT")!.pdfSha256 }))
    const sig = await inTenant(() => signKeyFactsAgreement({ ...base, agreementDocumentSha256: docs.find((d) => d.kind === "LOAN_AGREEMENT")!.pdfSha256, signature: "Synthetic Borrower", signingOtpChallengeId: null, ipAddress: "203.0.113.9" }))
    say("I2 ack", ack, "sign", sig)
    await attestKyc(id)
    await runWithTenant(stack.tenant, () => runScreening({ tenantId: stack.tenant, subject: { kind: "CLIENT", clientId: `${id}-client` } as never, trigger: "MANUAL" as never, applicationId: id, actor: { id: stack.officer, email: "o@test.invalid" } }))
    await verifyAccount(stack.officer, id)
    const r = await disburseAs(stack.disburser, id)
    say("I2 payout", r.status, (await j(r))?.disbursementPrecondition)
    expect(r.status).toBe(422)
  })

  it("B1: reference variants, retry, concurrent, across tenants", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `bv${x}-${t}`)
    for (const id of ids) await signedApplication(id)
    expect((await disburseAs(stack.disburser, ids[0], { bankRef: "TX-777 A" })).status).toBe(200)
    for (const [i, ref] of [[1, "tx-777 a"], [2, " TX-777 A "], [3, "TX-777  A"], [4, "TX777A"], [5, "ＴＸ-777 A"], [6, "TX-777 A"]] as const) {
      const r = await disburseAs(stack.disburser, ids[i], { bankRef: ref })
      say("B1 variant", JSON.stringify(ref), r.status, (await j(r))?.disbursementPrecondition)
    }
    const [x, y] = [`rta-${t}`, `rtb-${t}`]
    await signedApplication(x, { verified: false }); await signedApplication(y)
    const fail = await disburseAs(stack.disburser, x, { bankRef: "RETRY-1" })
    await verifyAccount(stack.officer, x)
    const retry = await disburseAs(stack.disburser, x, { bankRef: "RETRY-1" })
    say("B1 retry", fail.status, retry.status)
    const [p, q] = [`cca-${t}`, `ccb-${t}`]
    await signedApplication(p); await signedApplication(q)
    const both = await Promise.all([disburseAs(stack.disburser, p, { bankRef: "RACE-1" }), disburseAs(stack.disburser, q, { bankRef: "RACE-1" })])
    say("B1 race", both.map((r) => r.status), await Promise.all(both.map(async (r) => (await j(r))?.disbursementPrecondition)), await db().loan.count({ where: { applicationId: { in: [p, q] } } }))
    const other = `ten2-${t}`
    holder.tenantId = stack2.tenant
    await flow2.signedApplication(other)
    const cross = await flow2.disburseAs(stack2.disburser, other, { bankRef: "TX-777 A" })
    holder.tenantId = stack.tenant
    say("B1 cross-tenant", cross.status, await j(cross))
  })

  it("C1: dry run and real gate agree across the refusals", async () => {
    const compare = async (name: string, id: string) => {
      as(stack.disburser)
      const c = await j(await check(id))
      const r = await disburseAs(stack.disburser, id, { bankRef: `CMP-${name}` })
      say("C1", name, "dry", c.ok ?? false, c.disbursementPrecondition, "real", r.status, (await j(r))?.disbursementPrecondition)
    }
    const a = `c1a-${t}`
    await signedApplication(a, { verified: false }); await compare("noverify", a)
    const b = `c1b-${t}`
    await signedApplication(b, { kyc: false }); await compare("kyc", b)
    const c = `c1c-${t}`
    await signedApplication(c); await db().client.update({ where: { id: `${c}-client` }, data: { deceasedAt: new Date() } }); await compare("deceased", c)
    const d = `c1d-${t}`
    await signedApplication(d); await db().client.update({ where: { id: `${d}-client` }, data: { bankBranchCode: "100002" } }); await compare("branch", d)
    const e = `c1e-${t}`
    await signedApplication(e); await db().clientDocument.updateMany({ where: { clientId: `${e}-client`, docType: "BANK_STATEMENT" }, data: { verified: false, verifiedAt: null, verifiedById: null } }); await compare("statement", e)
    const f = `c1f-${t}`
    await approvedApplication(f); await compare("unsigned", f)
    const g = `c1g-${t}`
    await signedApplication(g); as(stack.officer); say("C1 approver dry", (await j(await check(g))).disbursementPrecondition)
    const before = (await db().loanApplication.findUniqueOrThrow({ where: { id: g } })).updatedAt
    as(stack.disburser); say("C1 ok dry", await j(await check(g)))
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: g } })).updatedAt).toEqual(before)
    // a dry run racing the real payout
    const results: number[] = []
    for (let i = 0; i < 6; i++) {
      const id = `c1r${i}-${t}`
      await signedApplication(id)
      as(stack.disburser)
      const rs = await Promise.all([check(id), disburseAs(stack.disburser, id, { bankRef: `RACE-D-${i}` }), check(id)])
      results.push(rs[1].status)
    }
    say("C1 race with dry run: real statuses", results)
  })

  it("M1: the hash", async () => {
    const baseline = (await import("node:fs")).readFileSync("prisma/migrations/20261009000000_baseline/migration.sql", "utf8")
    const m = /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?"affordabilityInputSha256"[\s\S]*?\$function\$;|CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?"affordabilityInputSha256"[\s\S]*?\$\$;/.exec(baseline)
    expect(m).toBeTruthy()
    await db().$executeRawUnsafe(m![0].replace(/(?:public\.)?"affordabilityInputSha256"/, `public."oldInputHash"`))
    const base = { monthlyIncomeCents: 2000000, monthlyExpensesCents: 800000, applicationDebtCents: 0, clientDebtCents: 0, declaredDebtCents: 0, bureauObligationsCents: 0, proposedInstalmentCents: 531900, principalCents: 500000, termDays: 30, productId: "p", interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL", initiationFeePct: 0.15, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 6900, initiationFeePayment: "DEFERRED", ndiBufferPct: 110 }
    const rep = { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }
    const pv = { id: "v1", version: 1, baseRatePm: 0.075, pricingRuleId: null, pricingRuleName: null, pricingInputs: {} }
    const cases: Array<[string, Record<string, unknown>]> = [["plain", base], ["cl", { ...base, creditLifePremiumCents: 0 }], ["cl2", { ...base, creditLifePremiumCents: 12345 }], ["repayment", { ...base, repayment: rep }], ["rep-inst", { ...base, repayment: { ...rep, instalments: 6 } }], ["id", { ...base, borrowerIdentity: "abc" }], ["ver", { ...base, productVersion: pv }], ["ver-rule", { ...base, productVersion: { ...pv, pricingRuleId: "r1", baseRatePm: 0.1 + 0.2 } }], ["all", { ...base, repayment: rep, borrowerIdentity: "abc", productVersion: pv }], ["tiny", { ...base, interestRatePm: 1e-7 }]]
    for (const [name, inputs] of cases) {
      const [row] = await db().$queryRawUnsafe<{ n: string; o: string }[]>(`SELECT public."affordabilityInputSha256"($1::jsonb) n, public."oldInputHash"($1::jsonb) o`, JSON.stringify(inputs))
      const js = affordabilityInputFingerprint(inputs as never)
      say("M1", name, "sql==js", row.n === js, "new==old", row.n === row.o)
    }
  })

  it("U1: UPFRONT fee", async () => {
    const id = `upf-${t}`
    const saved = { ...PRODUCT }
    Object.assign(PRODUCT, { initiationFeePct: 0.1 })
    await db().loanProduct.update({ where: { id: stack.product }, data: { initiationFeePct: 0.1 } })
    const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
    holder.files.set(statement.path, statement.bytes)
    const client = await db().client.findUniqueOrThrow({ where: { id: `${id}-client` }, include: { expenseBreakdown: true } })
    const row = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const sub = createSubmissionAffordabilitySnapshot({ capturedAt: row.submittedAt!, capturedById: stack.officer, client, applicationDebts: [], clientDebts: [], application: { appliedAmount: row.appliedAmount, appliedTermDays: row.appliedTermDays, productId: stack.product, initiationFeePayment: "UPFRONT" }, product: PRODUCT })
    await db().loanApplication.update({ where: { id }, data: { initiationFeePayment: "UPFRONT", affordabilityResult: withAffordabilitySnapshot(null, sub) as object } })
    await clearOpenFlags(db(), stack, id)
    const dec = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    say("U1 decide", dec.status, dec.status === 200 ? "" : await j(dec))
    expect(dec.status).toBe(200)
    await attestKyc(id); await issueAndSign(id); await verifyAccount(stack.officer, id)
    const r = await disburseAs(stack.disburser, id)
    say("U1 pay", r.status, (await j(r))?.disbursementPrecondition)
    expect(r.status).toBe(200)
    const a2 = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const calc = (a2.affordabilityResult as { approval: { calculator: Record<string, unknown> } }).approval.calculator
    const { schedule: _s, ...rest } = calc as { schedule: unknown }
    const loan = await db().loan.findFirstOrThrow({ where: { applicationId: id }, include: { repaymentSchedule: true } })
    say("U1 calc", rest)
    say("U1 loan", { principal: loan.principal, fee: loan.initiationFee, totalInterest: loan.totalInterest, totalRepayable: loan.totalRepayable, outstanding: loan.outstandingPrincipal }, loan.repaymentSchedule.map((s) => [s.principalDue, s.interestDue, s.feesDue, s.totalDue]))
    const src = await runWithTenant(stack.tenant, async () => (await loadSourceLoans(db() as never, stack.tenant, new Date(Date.now() + 86_400_000))).find((l) => l.id === loan.id)!)
    say("U1 GL", loanSources(src, new Date(Date.now() + 86_400_000)).filter((x) => x.baseKey.includes("disbursement")).map((x) => x.vector))
    const nl = await import("@/lib/notifications")
    say("U1 notify", (nl.triggerNotification as unknown as { mock: { calls: Array<[{ loanId?: string; data?: unknown }]> } }).mock.calls.filter((c) => c[0].loanId === loan.id).map((c) => c[0].data))
    as(stack.officer, "ADMIN")
    const pay = await paymentsRoute(new NextRequest("http://localhost/api/payments", { method: "POST", body: JSON.stringify({ loanId: loan.id, amount: loan.totalRepayable, paymentMethod: "EFT", reference: "PAYALL" }), headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() } }))
    const after = await db().loan.findUniqueOrThrow({ where: { id: loan.id } })
    say("U1 settle", pay.status, { status: after.status, outstanding: after.outstandingPrincipal, paid: after.totalPaid })
    Object.assign(PRODUCT, saved)
    await db().loanProduct.update({ where: { id: stack.product }, data: { initiationFeePct: saved.initiationFeePct } })
  })

  it("V1: versioned with grace, then a pricing rule (runs last)", async () => {
    const actor = (u: string) => ({ id: u, email: `${u}@test.invalid`, role: "ADMIN" as never, tenantId: stack.tenant, totpVerified: true })
    const config = { minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 21, maxTermDays: 180, interestRatePm: 0.05, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 6_900, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "FULL", graceInstalments: 1 }, collateral: [], eligibility: { minAge: 18, maxAge: 65, minMonthlyIncomeCents: null, minEmploymentMonths: null } }
    await runWithTenant(stack.tenant, async () => {
      const draft = await createDraft({ tenantId: stack.tenant, actor: actor(stack.officer), kind: PRODUCT_VERSION_KIND, title: "Grace", payload: { productId: stack.product, effectiveFrom: new Date().toISOString().slice(0, 10), config, reason: "Synthetic grace version for the breaker." } as never })
      await submit({ tenantId: stack.tenant, actor: actor(stack.officer), id: draft.id })
      await approve({ tenantId: stack.tenant, actor: actor(stack.senior), id: draft.id })
    })
    const seedIt = async (id: string) => {
      const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
      holder.files.set(statement.path, statement.bytes)
      await db().applicationPricingInput.create({ data: { applicationId: id, tenantId: stack.tenant, channel: STRUCTURED_SCHEDULE_CHANNEL } })
      await clearOpenFlags(db(), stack, id)
    }
    const id = `gr-${t}`
    await seedIt(id)
    const dec = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    say("V1 decide", dec.status, dec.status === 200 ? "" : await j(dec))
    if (dec.status === 200) {
      await attestKyc(id); await issueAndSign(id); await verifyAccount(stack.officer, id)
      as(stack.disburser); say("V1 dry", await j(await check(id)))
      const r = await disburseAs(stack.disburser, id)
      say("V1 real", r.status, await j(r))
      const loan = await db().loan.findFirst({ where: { applicationId: id }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
      if (loan) {
        const row = await db().loanApplication.findUniqueOrThrow({ where: { id } })
        const fz = (row.affordabilityResult as { approval: { calculator: { schedule: Array<{ dueDate: string; totalDue: number }>; totalRepayableCents: number } } }).approval.calculator
        say("V1 same as frozen", JSON.stringify(loan.repaymentSchedule.map((s) => [s.dueDate.toISOString(), s.totalDue])) === JSON.stringify(fz.schedule.map((s) => [s.dueDate, s.totalDue])), loan.totalRepayable, fz.totalRepayableCents, loan.repaymentSchedule.map((s) => [s.principalDue, s.interestDue, s.feesDue]))
        say("V1 frozen rows", (fz.schedule as unknown[]).slice(0, 5), "booked", loan.repaymentSchedule.map((x) => [x.installmentNo, x.dueDate.toISOString(), x.totalDue]))
        say("V1 terms", await db().loanTerms.findFirst({ where: { loanId: loan.id }, select: { deferredInterest: true, instalments: true, graceKind: true } }))
        const { loadRunLoans } = await import("@/lib/ifrs9/loan-input")
        const runAt = new Date(Date.now() + 40 * 86_400_000)
        const rows = await runWithTenant(stack.tenant, () => loadRunLoans(db() as never, stack.tenant, runAt))
        const mine = (rows as unknown as Array<{ id: string; status: string; startDate: Date; principal: number; outstandingPrincipal: number; graceDeferral?: unknown; schedule: unknown[] }>).find((l) => l.id === loan.id)
        say("V1 IFRS9 input", mine ? { status: mine.status, principal: mine.principal, outstanding: mine.outstandingPrincipal, rows: mine.schedule.length, grace: mine.graceDeferral } : "absent")
      }
    }
    const ruled = `rule-${t}`
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.productPricingRule.create({ data: { tenantId: stack.tenant, productId: stack.product, name: "Synthetic", validFrom: new Date("2020-01-01"), rateMode: "SET", rateValue: 0.04, changeRequestId: `rule-${t}` } as never })
    })
    await seedIt(ruled)
    const rd = await decideForm(ruled, { action: "approve", repaymentMethod: "EFT" })
    say("V1 rule decide", rd.status, rd.status === 200 ? "" : await j(rd))
  })
})
