/**
 * The money gates of a key-facts payout on real Postgres, through the real routes and with no session_replication_role shortcut: the frozen
 * approval binding at payout, the bank reference, the second person, payout-grade KYC, the agreement's start date (and the way back when it
 * has passed), and the lock protocol: another transaction holding the client's evidence, or a document, is waited for and then judged.
 *
 * Mocked as ls-end-to-end.integration.test.ts mocks: the RLS-bound client, the session guard, the tenant frame, notifications, the PDF
 * renderer and file storage.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-payout.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>() }))
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
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho payout IT", domain: null, status: "ACTIVE" })),
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
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))

import { createAppPrismaClient } from "@/lib/prisma"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import * as screeningGate from "@/lib/screening/gate"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { bankRefFor, lsFlow } from "./ls-flow.integration-fixture"
import { createRlsRole, seedStack, stackOf } from "./ls-stack.integration-fixture"
import { SECOND_PERSON_VERIFICATION_PROVIDER } from "./payout-terms"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lspay_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const { approvedApplication, attestKyc, decideForm, disburseAs, issueAndSign, signedApplication, verifyAccount } = lsFlow(db, stack, holder)
const loans = (id: string) => db().loan.count({ where: { applicationId: id } })

/** Still waiting on a lock after this long: it did not read past the holder. */
const WAIT_MS = 1_000
const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), WAIT_MS))])

/** A payout started while another connection's open transaction holds what `hold` took: it is still waiting when that commits. */
async function payoutWhileHolding(id: string, hold: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>): Promise<Response> {
  const payout = await db().$transaction(async (tx) => {
    await hold(tx)
    const started = disburseAs(stack.disburser, id)
    expect(await settled(started)).toBe(false)
    return { started }
  }, { timeout: 30_000 })
  return payout.started
}

suite("the gates of a key-facts payout (real Postgres, real routes, no bypass)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "PAY", isDemoLender: true })
    await createTemplate(db(), stack.tenant, OFFER_KEY, BODY("Offer letter"))
    await createTemplate(db(), stack.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)

  afterEach(() => { vi.useRealTimers() })

  afterAll(async () => {
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
  }, 60_000)

  it("the frozen approval binds at payout: the borrower's finances, the policy, or the stored terms changed after approval are refused", async () => {
    const income = `income-${t}`
    await signedApplication(income)
    await db().client.update({ where: { id: `${income}-client` }, data: { monthlyIncome: 1_900_000 } })
    const moved = await disburseAs(stack.disburser, income)
    expect(moved.status).toBe(422)
    expect(await moved.json()).toMatchObject({ disbursementPrecondition: "unchanged_affordability", affordabilitySnapshot: "changed" })

    const policy = `policy-${t}`
    await signedApplication(policy)
    await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: { ndiBufferPct: 120 } })
    const stricter = await disburseAs(stack.disburser, policy)
    await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: { ndiBufferPct: 110 } })
    expect(await stricter.json()).toMatchObject({ disbursementPrecondition: "unchanged_affordability", affordabilitySnapshot: "changed" })

    const terms = `terms-${t}`
    await signedApplication(terms)
    const row = await db().loanApplication.findUniqueOrThrow({ where: { id: terms } })
    const store = JSON.parse(JSON.stringify(row.affordabilityResult)) as { approval: { inputs: { principalCents: number } } }
    store.approval.inputs.principalCents = 800_000
    // The database refuses the frozen snapshot outright (current-approval.key-facts.test.ts proves the fingerprint refuses it too) ...
    await expect(db().loanApplication.update({ where: { id: terms }, data: { affordabilityResult: store as object } })).rejects.toThrow(/validated approval transition/)
    // ... but not the approved amount on the row: the frozen approval does.
    await db().loanApplication.update({ where: { id: terms }, data: { approvedAmount: 800_000 } })
    const altered = await disburseAs(stack.disburser, terms)
    expect(altered.status).toBe(422)
    expect(await altered.json()).toMatchObject({ disbursementPrecondition: "unchanged_affordability", affordabilitySnapshot: "changed" })
    expect(await db().loan.count({ where: { applicationId: { in: [income, policy, terms] } } })).toBe(0)
  })

  it("a manual transfer needs its bank reference: missing, blank, over-long and non-text ones book nothing", async () => {
    const id = `ref-${t}`
    await signedApplication(id)
    for (const body of [{}, { bankRef: null }, { bankRef: "   " }, { bankRef: "x".repeat(65) }, { bankRef: 1234 }, { bankRef: "two\nlines" }, { bankRef: "\u200b" }, { bankRef: "---" }]) {
      const res = await disburseAs(stack.disburser, id, body)
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ disbursementPrecondition: "bank_reference" })
    }
    expect(await loans(id)).toBe(0)
    const res = await disburseAs(stack.disburser, id, { bankRef: ` ${bankRefFor(id)} ` })
    expect(res.status).toBe(200)
    expect(await db().loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ disbursementRef: bankRefFor(id) })
  })

  it("a second person records the payout account, audited, and the disburser cannot be that person", async () => {
    const id = `second-${t}`
    await signedApplication(id, { verified: false })
    const none = await disburseAs(stack.disburser, id)
    expect(none.status).toBe(422)
    expect(await none.json()).toMatchObject({ disbursementPrecondition: "payout_account_verification" })

    expect((await verifyAccount(stack.confirmer, id, "too short")).status).toBe(400)
    const self = await verifyAccount(stack.disburser, id)
    expect(self.status).toBe(200)
    const own = await disburseAs(stack.disburser, id)
    expect(own.status).toBe(422)
    expect(await own.json()).toMatchObject({ disbursementPrecondition: "payout_account_verification", error: expect.stringMatching(/cannot also pay it out/) })
    expect(await loans(id)).toBe(0)

    const second = await verifyAccount(stack.confirmer, id)
    const { id: checkId } = await second.json() as { id: string }
    const check = await db().avsCheck.findUniqueOrThrow({ where: { id: checkId } })
    expect(check).toMatchObject({ provider: SECOND_PERSON_VERIFICATION_PROVIDER, checkedById: stack.confirmer, applicationId: id, accountNumber: "62000012345", passed: true })
    const audited = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: id, action: "PAYOUT_ACCOUNT_VERIFIED", userId: stack.confirmer } })
    expect(audited.newValue).toMatchObject({ avsCheckId: checkId })

    expect((await disburseAs(stack.disburser, id)).status).toBe(200)
    const disbursed = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DISBURSED" } })
    expect(disbursed.newValue).toMatchObject({ payoutAccountVerification: { avsCheckId: checkId, verifiedById: stack.confirmer } })
  })

  it("a confirmation is of one account: a change after it voids it, and it is recorded only for an approved key-facts application", async () => {
    const id = `moved-${t}`
    await signedApplication(id)
    // The branch: the statement match does not read it, so this is the second person's binding alone.
    await db().client.update({ where: { id: `${id}-client` }, data: { bankBranchCode: "100002" } })
    const res = await disburseAs(stack.disburser, id)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "payout_account_verification" })

    const unapproved = `unapproved-${t}`
    await approvedApplication(unapproved, { kyc: false })
    await decideForm(unapproved, { action: "return_to_review", reason: "Synthetic: the borrower asked to change the term." })
    expect((await verifyAccount(stack.confirmer, unapproved)).status).toBe(409)
    expect((await verifyAccount(stack.confirmer, `absent-${t}`)).status).toBe(404)
  })

  it("KYC at payout is VERIFIED: four verified documents alone are not, an in-person attestation is", async () => {
    const id = `pending-${t}`
    await signedApplication(id, { kyc: false })
    const res = await disburseAs(stack.disburser, id)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "composite_kyc" })
    await attestKyc(id)
    expect((await disburseAs(stack.disburser, id)).status).toBe(200)
  })

  it("screening is read again under the locks", async () => {
    const id = `screen-${t}`
    await signedApplication(id)
    const spy = vi.spyOn(screeningGate, "lockedBorrowerScreeningAllows").mockResolvedValueOnce(false)
    const res = await disburseAs(stack.disburser, id)
    spy.mockRestore()
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "screening" })
    expect(await loans(id)).toBe(0)
  })

  it("a borrower recorded as deceased after approval is not paid", async () => {
    const id = `deceased-${t}`
    await signedApplication(id)
    await db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date() } })
    const res = await disburseAs(stack.disburser, id)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "unchanged_affordability" })
    expect(await loans(id)).toBe(0)
  })

  it("is refused after the agreement's start date, and the way back works: return to review, approve, sign again, pay", async () => {
    const id = `late-${t}`
    await signedApplication(id)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + 86_400_000)
    const res = await disburseAs(stack.disburser, id)
    vi.useRealTimers()
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "schedule_expired" })
    expect(await loans(id)).toBe(0)

    const back = await decideForm(id, { action: "return_to_review", reason: "Synthetic: the signed agreement passed its start date." })
    expect(back.status, JSON.stringify(await back.clone().json())).toBe(200)
    const again = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    expect(again.status, JSON.stringify(await again.clone().json())).toBe(200)
    await issueAndSign(id)
    expect((await disburseAs(stack.disburser, id)).status).toBe(200)
  })

  it("waits on the client evidence lock the mutation routes hold", async () => {
    const id = `lockwait-${t}`
    await signedApplication(id)
    const res = await payoutWhileHolding(id, (tx) => lockAffordabilityClientEvidence(tx, { tenantId: stack.tenant, clientId: `${id}-client` }))
    expect(res.status).toBe(200)
  })

  it("an account changed under the lock is not paid: the payout loses the race and books nothing", async () => {
    const id = `locked-${t}`
    await signedApplication(id)
    const res = await payoutWhileHolding(id, async (tx) => {
      await lockAffordabilityClientEvidence(tx, { tenantId: stack.tenant, clientId: `${id}-client` })
      await tx.client.update({ where: { id: `${id}-client` }, data: { bankAccountNumber: "99999999999" } })
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "changed" })
    expect(await loans(id)).toBe(0)
  })

  it("holds the KYC and statement documents FOR SHARE: a writer on the document row alone is waited for", async () => {
    const id = `docrow-${t}`
    await signedApplication(id)
    const res = await payoutWhileHolding(id, (tx) => tx.$queryRaw`SELECT "id" FROM "ClientDocument" WHERE "clientId" = ${`${id}-client`} AND "docType" = 'BANK_STATEMENT'::"DocType" FOR UPDATE`)
    expect(res.status).toBe(200)
  })

  it("withdrawing the statement's verification mid-payout is waited for and refuses the payout", async () => {
    const id = `statement-${t}`
    await signedApplication(id)
    const res = await payoutWhileHolding(id, async (tx) => {
      await tx.clientDocument.updateMany({ where: { clientId: `${id}-client`, docType: "BANK_STATEMENT" }, data: { verified: false, verifiedAt: null, verifiedById: null } })
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "changed" })
    expect(await loans(id)).toBe(0)
  })
})
