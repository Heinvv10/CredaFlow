/**
 * PO funding against a migrated PostgreSQL (Fair Score audit; #141 review):
 * every create path refuses a PO_FUNDING application without its purchase
 * order, and the purchase order cannot be deleted out from under an
 * application that names it — including when the two race.
 *
 * Only the staff session is mocked; routes, locks and the database are real.
 *
 *   RUN_PO_FUNDING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/applications/po-funding.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { lockNewApplicationSubmissionEvidence, type ApplicationSubmissionTransaction } from "@/lib/applications/submission-lock"
import { isClientPoDocument } from "@/lib/applications/po-funding"
import { createDraftApplication } from "@/lib/lender-api/create-application"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { POST as staffCreate } from "@/app/api/applications/route"
import { DELETE as deleteDocument } from "@/app/api/documents/[id]/route"

const suite = process.env.RUN_PO_FUNDING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_po_${t}`
const domain = `po-${t}.po-funding-it.test`
const officer = `user_po_officer_${t}`
const superAdmin = `user_po_super_${t}`
let clientId = ""
let productId = ""

const signIn = (id: string, role: string) => {
  h.session = { user: { id, email: `${id}@test.invalid`, role, tenantId, totpVerified: true, totpEnrolmentRequired: false, tokenVersion: 0 } }
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const del = (id: string) => deleteDocument(
  new NextRequest(`http://${domain}/api/documents/${id}`, { method: "DELETE", headers: { host: domain } }),
  params(id),
)

/** One open application per client and product is allowed, so each case gets its own client. */
async function freshClient(): Promise<void> {
  clientId = (await db.client.create({ data: {
    tenantId, idNumber: syntheticSaId(), firstName: "Synthetic", lastName: "Owner",
    email: `po-${randomUUID().slice(0, 8)}-${t}@client.invalid`, phone: "0820000000",
    monthlyIncome: 10_000_000, monthlyExpenses: 1_000_000,
  } })).id
}

async function poDocument(): Promise<string> {
  return (await db.clientDocument.create({ data: {
    tenantId, clientId, docType: "PO_DOCUMENT", fileUrl: "", fileName: "po.pdf", uploadedByType: "client",
  } })).id
}

async function applicationNaming(documentId: string, status: "SUBMITTED" | "DECLINED" | "CANCELLED" = "SUBMITTED") {
  return db.loanApplication.create({ data: {
    tenantId, reference: `PO-IT-${randomUUID().slice(0, 8)}`, clientId, productId, appliedAmount: 5_000_000, appliedTermDays: 60,
    status, loanPurposeCategory: "BUSINESS", poNumber: "PO-1", poBuyerName: "Synthetic Buyer", poDocumentId: documentId,
  } })
}

suite("PO funding (real database)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `po-${t}`, name: "PO funding IT", domain } })
    await db.user.createMany({ data: [
      { id: officer, tenantId, role: "CREDIT_OFFICER", email: `${officer}@test.invalid`, name: "Synthetic Officer", password: "not-a-login-credential" },
      { id: superAdmin, tenantId, role: "SUPER_ADMIN", email: `${superAdmin}@test.invalid`, name: "Synthetic Super", password: "not-a-login-credential" },
    ] })
    productId = (await db.loanProduct.create({ data: {
      tenantId, code: "POFUND", name: "Purchase Order Funding", productType: "PO_FUNDING", minAmount: 1_000_000,
      maxAmount: 50_000_000, minTermDays: 30, maxTermDays: 120, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL",
      initiationFeePct: 0.02,
    } })).id
  })

  afterAll(async () => { await db.$disconnect() })

  it("lender API: refuses a PO-funding draft without the purchase order", async () => {
    await freshClient()
    const outcome = await createDraftApplication(
      { keyId: "k", tenantId, scopes: ["applications:write"], createdById: officer },
      { clientId, productId, appliedAmountCents: 1_000_000, appliedTermDays: 30, purpose: "Supply school uniforms", loanPurposeCategory: "BUSINESS" },
    )
    expect(outcome.status).toBe(422)
    expect(outcome.body).toMatchObject({ error: { code: "po_funding_not_supported" } })
    expect(JSON.stringify(outcome.body)).toMatch(/not supported via the API/i)
    expect(await db.loanApplication.count({ where: { tenantId, poDocumentId: null, productId } })).toBe(0)
  })

  it("staff POST /api/applications: refuses PO funding without the order, stores it with one", async () => {
    await freshClient()
    signIn(officer, "CREDIT_OFFICER")
    const body = {
      clientId, productId, appliedAmount: 5_000_000, appliedTermDays: 60, purpose: "Supply school uniforms",
      purposeDetails: "", loanPurposeCategory: "BUSINESS", affordabilityFlag: "PASS", submitForReview: false,
    }
    const post = (b: unknown) => staffCreate(new NextRequest(`http://${domain}/api/applications`, {
      method: "POST", headers: { host: domain, "content-type": "application/json" }, body: JSON.stringify(b),
    }))

    const refused = await post(body)
    expect(refused.status).toBe(422)
    expect(JSON.stringify(await refused.json())).toMatch(/purchase order number/i)

    const documentId = await poDocument()
    const created = await post({ ...body, poNumber: "PO-2026-0412", poBuyerName: "Synthetic Schools Trust", poDocumentId: documentId })
    expect(created.status).toBe(200)
    const row = await db.loanApplication.findFirstOrThrow({ where: { tenantId, poDocumentId: documentId } })
    expect(row).toMatchObject({ poNumber: "PO-2026-0412", poBuyerName: "Synthetic Schools Trust" })
  })

  it("holds a PO document while a live application names it, and releases it once DECLINED", async () => {
    await freshClient()
    signIn(superAdmin, "SUPER_ADMIN")
    const documentId = await poDocument()
    const app = await applicationNaming(documentId)

    expect((await del(documentId)).status).toBe(409)
    expect((await db.clientDocument.findUniqueOrThrow({ where: { id: documentId } })).deletedAt).toBeNull()

    await db.loanApplication.update({ where: { id: app.id }, data: { status: "DECLINED" } })
    expect((await del(documentId)).status).toBe(200)
    expect((await db.clientDocument.findUniqueOrThrow({ where: { id: documentId } })).deletedAt).not.toBeNull()
  })

  it("never leaves an application naming a deleted PO document when create and delete race", async () => {
    signIn(superAdmin, "SUPER_ADMIN")
    for (let round = 0; round < 6; round++) {
      await freshClient()
      const documentId = await poDocument()
      const create = db.$transaction(async (plainTx) => {
        // The app's client is the tenant-scoped extension; the locks only need raw SQL and the delegate.
        const tx = plainTx as unknown as ApplicationSubmissionTransaction
        await lockNewApplicationSubmissionEvidence(tx, { tenantId, clientId, productId })
        if (!(await isClientPoDocument(tx, { tenantId, clientId, documentId }))) return null
        // Hold the lock long enough for the delete to arrive mid-transaction.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return tx.loanApplication.create({ data: {
          tenantId, reference: `PO-RACE-${randomUUID().slice(0, 8)}`, clientId, productId, appliedAmount: 5_000_000,
          appliedTermDays: 60, status: "SUBMITTED", loanPurposeCategory: "BUSINESS", poNumber: "PO-1",
          poBuyerName: "Synthetic Buyer", poDocumentId: documentId,
        } })
      })
      const [created, deleted] = round % 2 === 0
        ? await Promise.all([create, del(documentId)])
        : await Promise.all([del(documentId), create]).then(([d, c]) => [c, d] as const)

      const doc = await db.clientDocument.findUniqueOrThrow({ where: { id: documentId } })
      if (created) {
        expect(deleted.status).toBe(409)
        expect(doc.deletedAt).toBeNull()
      } else {
        expect(deleted.status).toBe(200)
        expect(doc.deletedAt).not.toBeNull()
      }
    }
  })

  it("holds a proof of payment while its payment notification is pending", async () => {
    await freshClient()
    signIn(superAdmin, "SUPER_ADMIN")
    const loan = await db.loan.create({ data: {
      tenantId, reference: `LN-PO-${t}`, applicationId: (await db.loanApplication.create({ data: {
        tenantId, reference: `PO-IT-${randomUUID().slice(0, 8)}`, clientId, productId, appliedAmount: 100_000, appliedTermDays: 60,
      } })).id,
      clientId, productId, principal: 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000,
      outstandingPrincipal: 100_000, startDate: new Date("2026-09-01"), maturityDate: new Date("2026-11-01"),
      interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 0,
    } })
    const proof = (await db.clientDocument.create({ data: {
      tenantId, clientId, docType: "PROOF_OF_PAYMENT", fileUrl: "", fileName: "pop.pdf", uploadedByType: "client",
    } })).id
    const notification = await db.paymentNotification.create({ data: {
      tenantId, loanId: loan.id, clientId, amount: 10_000, documentId: proof,
    } })

    expect((await del(proof)).status).toBe(409)
    await db.paymentNotification.update({
      where: { id: notification.id },
      data: { status: "REJECTED", rejectReason: "No such deposit", resolvedById: superAdmin, resolvedAt: new Date() },
    })
    expect((await del(proof)).status).toBe(200)
  })
})
