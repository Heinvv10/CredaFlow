/**
 * Real-Postgres proof of the key-facts document flow through its library
 * (issue -> acknowledge -> sign), against a Lesotho (KEY_FACTS) instance, with the
 * PDF renderer and file storage replaced by in-memory stand-ins (the bytes are
 * hashed and re-read exactly as in production). The database gate itself is in
 * gate.integration.test.ts.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/non-nca-documents/flow.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { approvedAffordabilityResult } from "./approval.integration-fixture"
import { AGREEMENT_KEY, KFS_KEY, createTemplate, publishVersion } from "./gate.integration-fixture"

const holder = vi.hoisted(() => ({ db: null as unknown, files: new Map<string, Buffer>(), onRender: null as null | (() => Promise<void>) }))
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_t, key) => (holder.db as Record<string | symbol, unknown>)[key] }) }))
vi.mock("@/lib/storage", () => ({
  saveFile: async (buffer: Buffer) => { const path = `/mem/${holder.files.size}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  deleteFile: async (path: string) => { holder.files.delete(path) },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => { await holder.onRender?.(); return Buffer.from(`%PDF-synthetic ${html}`) } }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))

import { issueLoanDocuments } from "./issue"
import { acknowledgeKeyFacts } from "./acknowledge"
import { signKeyFactsAgreement } from "./sign"
import { loanDocumentState, documentProblem } from "./state"
import { keyFactsRefusal } from "./refusal"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.totalRepayable}}</p>`

suite("key-facts documents: issue, acknowledge, sign (real DB)", () => {
  let fresh: ThrowawayDb
  const db = (): PrismaClient => fresh.db

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.db = fresh.db
    // The approval below is priced (due dates follow the lender's calendar) and printed (loti) under the instance's jurisdiction, as in the app.
    await ensureActiveJurisdiction()
  }, 240_000)
  afterAll(() => fresh?.drop())

  /** An APPROVED key-facts application with a real approval snapshot, and the lender's two templates. */
  async function approvedApplication() {
    const t = await createChargesTenant(db(), false)
    const n = t.tenantId.slice(-8)
    const clientId = `c_fl_${n}`
    await db().client.create({ data: { id: clientId, tenantId: t.tenantId, idNumber: `F${n}`, firstName: "Thabo", lastName: "Synthetic", email: `${n}@client.invalid`, phone: "+26658000077" } })
    const product = await db().loanProduct.findUniqueOrThrow({ where: { id: t.productId } })
    const app = await db().loanApplication.create({ data: { tenantId: t.tenantId, reference: `APP-FL-${n}`, clientId, productId: t.productId, appliedAmount: 500_000, appliedTermDays: 90 } })
    const capturedAt = new Date()
    await db().loanApplication.update({ where: { id: app.id }, data: { status: "SUBMITTED" } })
    await db().loanApplication.update({ where: { id: app.id }, data: { status: "UNDER_REVIEW" } })
    await db().$transaction(async (tx) => {
      // Test setup: the approval transition of an application is NCA-calibrated (a separate item); only the approved state is installed.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.loanApplication.update({
        where: { id: app.id },
        data: {
          status: "APPROVED", approvedAt: capturedAt, approvedById: t.userId, approvedAmount: 500_000, approvedTermDays: 90, repaymentMethod: "EFT",
          affordabilityResult: approvedAffordabilityResult({ capturedAt, principalCents: 500_000, termDays: 90, productId: t.productId, interestRatePm: 0.023, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: product.monthlyServiceFee }) as never,
        },
      })
    })
    const kfs = await createTemplate(db(), t.tenantId, KFS_KEY, BODY("Key facts"))
    const agreement = await createTemplate(db(), t.tenantId, AGREEMENT_KEY, BODY("Agreement"))
    return { tenantId: t.tenantId, userId: t.userId, clientId, applicationId: app.id, kfs, agreement, email: `${n}@client.invalid` }
  }
  const staff = (fx: { userId: string }) => ({ id: fx.userId, email: "officer@test.invalid" })

  it("issues both documents from the current approved versions, binds the agreement, and audits it", async () => {
    const fx = await approvedApplication()
    const result = await issueLoanDocuments({ tenantId: fx.tenantId, applicationId: fx.applicationId, staff: staff(fx) })
    expect(result).toMatchObject({ ok: true })
    const state = (await loanDocumentState(fx.tenantId, fx.applicationId))!.keyFacts!
    expect(state.documents.map((d) => d.kind).sort()).toEqual(["KEY_FACTS_STATEMENT", "LOAN_AGREEMENT"])
    // Issued but not yet acknowledged: the gate's own test passes (the acknowledgement is checked at the signature itself).
    expect(state.signingProblem).toBeNull()
    const app = await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })
    expect(app.agreementDocumentSha256).toBe(state.documents.find((d) => d.kind === "LOAN_AGREEMENT")!.pdfSha256)
    expect(await db().auditLog.count({ where: { tenantId: fx.tenantId, action: "LOAN_DOCUMENTS_ISSUED", entityId: fx.applicationId } })).toBe(1)
    // The figures printed are the approved ones, in the lender's currency (loti), not text the system wrote.
    const printed = [...holder.files.values()].at(-1)!.toString()
    expect(printed).toMatch(/M 5,000\.00/)
  })

  it("acknowledge, then sign: the whole ceremony, once, with the signature recorded", async () => {
    const fx = await approvedApplication()
    await issueLoanDocuments({ tenantId: fx.tenantId, applicationId: fx.applicationId, staff: staff(fx) })
    const docs = (await loanDocumentState(fx.tenantId, fx.applicationId))!.keyFacts!.documents
    const kfs = docs.find((d) => d.kind === "KEY_FACTS_STATEMENT")!
    const agreement = docs.find((d) => d.kind === "LOAN_AGREEMENT")!
    const base = { tenantId: fx.tenantId, applicationId: fx.applicationId, clientId: fx.clientId, clientEmail: fx.email }

    // Signing first is refused, with the database's reason.
    const early = await signKeyFactsAgreement({ ...base, agreementDocumentSha256: agreement.pdfSha256, signature: "Thabo Synthetic", signingOtpChallengeId: null, ipAddress: "203.0.113.5" })
    expect(early).toMatchObject({ ok: false, error: expect.stringMatching(/key facts statement has not been acknowledged/) })
    // A stale digest is refused, and nobody else can acknowledge.
    expect(await acknowledgeKeyFacts({ ...base, shown: "0".repeat(64) })).toMatchObject({ ok: false, status: 409 })
    expect(await acknowledgeKeyFacts({ ...base, clientId: "someone-else", shown: kfs.pdfSha256 })).toMatchObject({ ok: false, status: 404 })
    expect(await acknowledgeKeyFacts({ ...base, shown: kfs.pdfSha256 })).toMatchObject({ ok: true })

    expect(await signKeyFactsAgreement({ ...base, agreementDocumentSha256: "0".repeat(64), signature: "Thabo Synthetic", signingOtpChallengeId: null, ipAddress: "203.0.113.5" })).toMatchObject({ ok: false, error: expect.stringMatching(/replaced after this page loaded/) })
    expect(await signKeyFactsAgreement({ ...base, agreementDocumentSha256: agreement.pdfSha256, signature: "  ", signingOtpChallengeId: null, ipAddress: "203.0.113.5" })).toMatchObject({ ok: false, status: 422 })
    expect(await signKeyFactsAgreement({ ...base, agreementDocumentSha256: agreement.pdfSha256, signature: "Thabo Synthetic", signingOtpChallengeId: null, ipAddress: "203.0.113.5" })).toMatchObject({ ok: true })
    expect(await signKeyFactsAgreement({ ...base, agreementDocumentSha256: agreement.pdfSha256, signature: "Thabo Synthetic", signingOtpChallengeId: null, ipAddress: "203.0.113.5" })).toMatchObject({ ok: false, error: expect.stringMatching(/already signed/) })

    const app = await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })
    expect(app).toMatchObject({ agreementSignedMethod: "portal", agreementSignedByIp: "203.0.113.5", agreementSignatureData: "Thabo Synthetic" })
    expect(await db().auditLog.count({ where: { tenantId: fx.tenantId, action: { in: ["KEY_FACTS_ACKNOWLEDGED", "KEY_FACTS_AGREEMENT_SIGNED"] } } })).toBe(2)
    // Signed: the documents hold for disbursement and the disburse route's gate says so (the payout itself is a later item).
    expect(await documentProblem(fx.applicationId, false)).toBeNull()
    const refusal = await keyFactsRefusal(fx.tenantId, fx.applicationId, "disburse")
    expect(refusal?.status).toBe(409)
    expect(await refusal?.json()).toMatchObject({ disbursementPrecondition: "non_nca_payout_unavailable" })
  })

  it("a template published after the issue stops the signature; issuing again from the new version lets it through", async () => {
    const fx = await approvedApplication()
    await issueLoanDocuments({ tenantId: fx.tenantId, applicationId: fx.applicationId, staff: staff(fx) })
    await publishVersion(db(), fx.agreement.templateId, 2, BODY("Agreement v2"))
    expect((await loanDocumentState(fx.tenantId, fx.applicationId))!.keyFacts!.signingProblem).toMatch(/no longer the current approved version/)
    const again = await issueLoanDocuments({ tenantId: fx.tenantId, applicationId: fx.applicationId, staff: staff(fx) })
    expect(again).toMatchObject({ ok: true })
    expect((await loanDocumentState(fx.tenantId, fx.applicationId))!.keyFacts!.documents.find((d) => d.kind === "LOAN_AGREEMENT")!.templateVersion).toBe(2)
    expect(await db().loanDocumentIssuance.count({ where: { applicationId: fx.applicationId, supersededAt: { not: null } } })).toBe(2)
  })

  it("refuses to issue without an approved template, for an unapproved application, and after signing; the disburse gate names what is missing", async () => {
    const fx = await approvedApplication()
    await db().documentTemplate.update({ where: { id: fx.kfs.templateId }, data: { isActive: false } })
    await expect(issueLoanDocuments({ tenantId: fx.tenantId, applicationId: fx.applicationId, staff: staff(fx) })).rejects.toThrow(/not published and available/)
    expect(await db().loanDocumentIssuance.count({ where: { applicationId: fx.applicationId } })).toBe(0)
    const refusal = await keyFactsRefusal(fx.tenantId, fx.applicationId, "disburse")
    expect(refusal?.status).toBe(422)
    expect(await refusal?.json()).toMatchObject({ error: expect.stringMatching(/the borrower has not signed the loan agreement/), disbursementPrecondition: "non_nca_documents" })
  })

  it("refuses when the approved terms move while the documents render, and leaves no row and no file behind", async () => {
    const fx = await approvedApplication()
    const filesBefore = holder.files.size
    holder.onRender = async () => {
      holder.onRender = null
      await db().loanApplication.update({ where: { id: fx.applicationId }, data: { approvedAmount: 900_000 } })
    }
    const result = await issueLoanDocuments({ tenantId: fx.tenantId, applicationId: fx.applicationId, staff: staff(fx) })
    expect(result).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/changed while the documents were being issued/) })
    expect(await db().loanDocumentIssuance.count({ where: { applicationId: fx.applicationId } })).toBe(0)
    expect(holder.files.size).toBe(filesBefore)
  })
})
