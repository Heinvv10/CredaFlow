/**
 * The shown-statement gate on every channel that can make a key-facts application (tender 2.2.4, pre-submission.ts). The portal's
 * side is in ls-walk.integration.test.ts. Staff capture keeps the gate; the public form and a lead's conversion are refused.
 * The census of channels is submission-channels.test.ts. Real routes on real Postgres; mocks as in ls-walk.integration.test.ts.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-channels.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({
  app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>(),
  session: null as null | { user: Record<string, unknown> },
  sendEmail: vi.fn(async (..._args: unknown[]) => ({ ok: true, messageId: `provider-${Math.random()}`, provider: "SMTP", providerOutcome: "ACCEPTED", acceptedAt: new Date() })),
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
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => holder.session) }))
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho channels IT", domain: null, status: "ACTIVE" })),
    getTenantFromRequest: async () => ({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho channels IT", domain: null, status: "ACTIVE" }),
  }
})
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => ({ failedLegs: [] })) }))
vi.mock("@/lib/email/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/service")>()), sendEmail: holder.sendEmail }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  saveFile: async (buffer: Buffer) => { const path = `/mem/${randomUUID()}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const identity = { legalName: "Demo Basotho Lending (Pty) Ltd", tradingName: "Demo Basotho Lending", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }
  return { ...(await importOriginal<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => identity, getLenderIdentity: async () => identity }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { POST as createApplication } from "@/app/api/applications/route"
import { PATCH as patchApplication } from "@/app/api/applications/[id]/route"
import { POST as draftQuote } from "@/app/api/applications/[id]/key-facts-quote/route"
import { POST as convertLead } from "@/app/api/crm/leads/[id]/convert/route"
import { POST as websiteApply } from "@/app/api/website/apply/route"
import { createDeal } from "@/lib/asset-finance/deal-create"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { createRlsRole, seedBorrower, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lschan_${t}`
const BODY = "<h1>Key facts statement</h1><p>{{client.fullName}} {{quote.principal}} {{quote.totalRepayable}}</p>"

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const json = (body: unknown, method = "POST") => new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const on = (id: string) => ({ params: Promise.resolve({ id }) })
const staff = () => { holder.userId = stack.officer; holder.role = "LOAN_ADMIN"; holder.session = { user: { id: stack.officer, role: "LOAN_ADMIN", email: `${stack.officer}@test.invalid`, tenantId: stack.tenant } } }
const applications = (clientId: string) => db().loanApplication.count({ where: { tenantId: stack.tenant, clientId } })
const wizard = (clientId: string, over: object = {}) => ({
  clientId, productId: stack.product, appliedAmount: 500_000, appliedTermDays: 30, affordabilityFlag: "PASS", purpose: "School fees", purposeDetails: "", loanPurposeCategory: "EDUCATION",
  poNumber: "", poBuyerName: "", poDocumentId: "", monthlyInstalment: "", firstInstalment: "", totalInterest: "", initiationFee: "", serviceFees: "", ...over,
})

suite("every channel that makes a key-facts application (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "CHN", isDemoLender: true })
    for (const key of [OFFER_KEY, KFS_KEY, AGREEMENT_KEY]) await createTemplate(db(), stack.tenant, key, BODY)
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)

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

  it("the public website keeps the lead and makes no application", async () => {
    const email = `web-${t}@test.invalid`
    const res = await websiteApply(json({
      firstName: "Synthetic", lastName: "Visitor", email, phone: "+26658000099", idNumber: "990000099", employmentStatus: "EMPLOYED", employerName: "Example",
      monthlyIncome: 20_000, monthlyExpenses: 8_000, productType: "MICRO", amount: 5_000, termDays: 30, purpose: "School fees", turnstileToken: "x", popiaConsent: true, source: "WEBSITE",
    }))
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(422)
    expect(body).toMatchObject({ keyFacts: "required" })
    expect(await db().lead.count({ where: { tenantId: stack.tenant, email } })).toBe(1)
    expect(await db().client.count({ where: { tenantId: stack.tenant, email } })).toBe(0)
    expect(await db().loanApplication.count({ where: { tenantId: stack.tenant } })).toBe(0)
  })

  it("a lead's conversion is refused before it does anything", async () => {
    staff()
    const lead = await db().lead.create({ data: { tenantId: stack.tenant, firstName: "Synthetic", lastName: "Lead", phone: "+26658000098", source: "WEBSITE" } })
    const res = await convertLead(json({ idNumber: "990000098" }), on(lead.id))
    expect(res.status).toBe(409)
    expect(await db().lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "NEW", convertedToApplicationId: null })
  })

  it("staff cannot submit in one call: a new application with submitForReview makes nothing", async () => {
    staff()
    const id = `one-${t}`
    await seedBorrower(db(), stack, id)
    const res = await createApplication(json(wizard(`${id}-client`, { submitForReview: true })))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ keyFacts: "required" })
    expect(await applications(`${id}-client`)).toBe(0)
  })

  it("asset finance is refused: no deal, so no application", async () => {
    const result = await db().$transaction((tx) => createDeal(tx as never, { tenantId: stack.tenant, userId: stack.officer, input: {} as never }))
    expect(result).toMatchObject({ kind: "refused", status: 409 })
    expect(await db().assetFinanceDeal.count({ where: { tenantId: stack.tenant } })).toBe(0)
  })

  describe("a staff draft", () => {
    const id = `draft-${t}`
    let draft = ""
    beforeAll(async () => {
      staff()
      await seedBorrower(db(), stack, id)
      const res = await createApplication(json(wizard(`${id}-client`, { submitForReview: false })))
      const body = await res.json()
      expect(res.ok, JSON.stringify(body)).toBe(true)
      draft = body.id
    }, 60_000)
    const status = async () => (await db().loanApplication.findUniqueOrThrow({ where: { id: draft } })).status

    it("is refused the wizard's own submit, and a submit with no statement", async () => {
      staff()
      expect((await patchApplication(json({ action: "update", ...wizard(`${id}-client`, { submitForReview: true }) }, "PATCH"), on(draft))).status).toBe(422)
      expect((await patchApplication(json({ status: "SUBMITTED" }, "PATCH"), on(draft))).status).toBe(422)
      expect(await status()).toBe("DRAFT")
    })

    it("is refused on a statement for other terms, or on a digest that is no statement", async () => {
      staff()
      const quote = await (await draftQuote(json({}), on(draft))).json()
      await db().loanApplication.update({ where: { id: draft }, data: { appliedAmount: 600_000 } })
      expect((await patchApplication(json({ status: "SUBMITTED", keyFactsDocumentSha256: quote.sha256 }, "PATCH"), on(draft))).status).toBe(422)
      await db().loanApplication.update({ where: { id: draft }, data: { appliedAmount: 500_000 } })
      expect((await patchApplication(json({ status: "SUBMITTED", keyFactsDocumentSha256: "0".repeat(64) }, "PATCH"), on(draft))).status).toBe(422)
      expect(await status()).toBe("DRAFT")
    })

    it("submits on the statement for its terms, which the application then claims and the audit row names", async () => {
      staff()
      const quote = await (await draftQuote(json({}), on(draft))).json()
      expect(quote).toMatchObject({ figures: { amount: "M 5,000.00" } })
      expect([...holder.files.values()].at(-1)!.toString()).toContain("INDICATIVE")
      const res = await patchApplication(json({ status: "SUBMITTED", keyFactsDocumentSha256: quote.sha256 }, "PATCH"), on(draft))
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
      expect(await status()).toBe("SUBMITTED")
      expect(await db().clientDocument.findUniqueOrThrow({ where: { id: quote.documentId } })).toMatchObject({ issuedForApplicationId: draft, uploadedByType: "staff", uploadedById: stack.officer })
      const audit = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: draft, action: "APPLICATION_SUBMITTED_BY_STAFF" } })
      expect(audit.newValue).toMatchObject({ indicativeKeyFactsDocumentId: quote.documentId })
      expect((await draftQuote(json({}), on(draft))).status, "a statement is for a draft").toBe(400)
    })
  })
})
