/**
 * Real-Postgres proof of who may read the signing packet and what a read logs.
 *
 * route.test.ts models Prisma with a fake. Here the tenant-scoped client, the
 * `{ id, tenantId }` lookup and the DocumentAccessLog writes run for real; only
 * the session is supplied.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_SIGNING_PACKET_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/signing-packet/route.integration.test.ts'
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

type Session = { user: { id: string; email: string; role: string; tenantId: string } } | null
const authState = vi.hoisted(() => ({ session: null as Session }))

vi.mock("@/lib/auth", () => ({ auth: async () => authState.session }))

import { GET } from "./route"

const RUN = process.env.RUN_SIGNING_PACKET_IT === "1"
const suite = RUN ? describe : describe.skip

async function pdfBytes(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) pdf.addPage([200, 200])
  return Buffer.from(await pdf.save())
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

suite("signing packet ownership and access log", () => {
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const ids = {
    lender: `tenant_packet_a_${token}`,
    otherLender: `tenant_packet_b_${token}`,
    owner: `client_packet_owner_${token}`,
    neighbour: `client_packet_neighbour_${token}`,
    outsider: `client_packet_outsider_${token}`,
    product: `product_packet_${token}`,
    application: `application_packet_${token}`,
    product2: `product_packet_2_${token}`,
    crossPasq: `application_packet_cross_pasq_${token}`,
    crossAgreement: `application_packet_cross_agreement_${token}`,
    pasq: `document_packet_pasq_${token}`,
    agreement: `document_packet_agreement_${token}`,
    neighbourPasq: `document_packet_neighbour_pasq_${token}`,
    neighbourAgreement: `document_packet_neighbour_agreement_${token}`,
  }
  const slugs = { lender: `packet-a-${token}`, otherLender: `packet-b-${token}` }
  let storageDir: string

  const client = (id: string, tenantId: string): Session => ({
    user: { id, email: `${id}@test.invalid`, role: "CLIENT", tenantId },
  })

  /** `slug` is the lender whose deployment the request arrives at. */
  function read(session: Session, slug = slugs.lender, applicationId = ids.application): Promise<Response> {
    authState.session = session
    const req = new NextRequest(
      `http://portal.test.invalid/api/applications/${applicationId}/signing-packet`,
      { headers: { "x-tenant-slug": slug } },
    )
    return GET(req, { params: Promise.resolve({ id: applicationId }) }) as Promise<Response>
  }

  const documentIds = [ids.pasq, ids.agreement, ids.neighbourPasq, ids.neighbourAgreement]
  const accessRows = () =>
    db.documentAccessLog.findMany({
      where: { documentId: { in: documentIds } },
      select: { documentId: true, accessorType: true, accessorId: true, action: true },
      orderBy: { documentId: "asc" },
    })

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), "signing-packet-it-"))
    const pasq = await pdfBytes(2)
    const agreement = await pdfBytes(3)
    const pasqPath = path.join(storageDir, "pasq.pdf")
    const agreementPath = path.join(storageDir, "agreement.pdf")
    await writeFile(pasqPath, pasq)
    await writeFile(agreementPath, agreement)

    await db.tenant.createMany({
      data: [
        { id: ids.lender, slug: slugs.lender, name: "Packet Lender A" },
        { id: ids.otherLender, slug: slugs.otherLender, name: "Packet Lender B" },
      ],
    })
    await db.client.createMany({
      data: [
        [ids.owner, ids.lender, "1"],
        [ids.neighbour, ids.lender, "2"],
        [ids.outsider, ids.otherLender, "3"],
      ].map(([id, tenantId, n]) => ({
        id,
        tenantId,
        reference: `CLI-PACKET-${n}-${token}`,
        idNumber: `PACKET-${n}-${token}`,
        firstName: "Synthetic",
        lastName: `Packet ${n}`,
        email: `${id}@test.invalid`,
        phone: `+2782000003${n}`,
      })),
    })
    // Two products: one open application per client and product.
    await db.loanProduct.createMany({
      data: [[ids.product, "1"], [ids.product2, "2"]].map(([id, n]) => ({
        id,
        tenantId: ids.lender,
        code: `PACKET-${n}-${token}`,
        name: `Packet product ${n}`,
        productType: "PERSONAL",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
      })),
    })
    const generatedAt = new Date("2026-10-01T08:00:00.000Z")
    const evidenceSha256 = "b".repeat(64)
    // The other two are the neighbour's OWN applications, each with one
    // pointer at the owner's document and the other at the neighbour's own.
    // The database binds the PASQ pointer to its client only once an
    // application is APPROVED (guardLoanApplicationTenantBinding), and the
    // agreement pointer not at all, so these rows are writable; the route is
    // what must refuse to serve them.
    for (const [applicationId, clientId, productId, pasqId, agreementId, n] of [
      [ids.application, ids.owner, ids.product, ids.pasq, ids.agreement, "1"],
      [ids.crossPasq, ids.neighbour, ids.product, ids.pasq, ids.neighbourAgreement, "2"],
      [ids.crossAgreement, ids.neighbour, ids.product2, ids.neighbourPasq, ids.agreement, "3"],
    ]) {
      await db.loanApplication.create({
        data: {
          id: applicationId,
          tenantId: ids.lender,
          reference: `APP-PACKET-${n}-${token}`,
          clientId,
          productId,
          appliedAmount: 500_000,
          appliedTermDays: 30,
          status: "UNDER_REVIEW",
          pasqVersion: "pasq-v3",
          pasqGeneratedAt: generatedAt,
          pasqDocumentId: pasqId,
          pasqDocumentSha256: sha(pasq),
          pasqEvidence: {
            version: "pasq-v3",
            tenantId: ids.lender,
            applicationId,
            clientId,
            productId,
            evidenceSha256,
          },
          pasqEvidenceSha256: evidenceSha256,
          agreementGeneratedAt: generatedAt,
          agreementDocumentId: agreementId,
          agreementDocumentSha256: sha(agreement),
        },
      })
    }
    await db.clientDocument.createMany({
      data: [
        [ids.pasq, ids.owner, "FORM_20_PRE_AGREEMENT", pasqPath, sha(pasq)],
        [ids.agreement, ids.owner, "CREDIT_AGREEMENT", agreementPath, sha(agreement)],
        [ids.neighbourPasq, ids.neighbour, "FORM_20_PRE_AGREEMENT", pasqPath, sha(pasq)],
        [ids.neighbourAgreement, ids.neighbour, "CREDIT_AGREEMENT", agreementPath, sha(agreement)],
      ].map(([id, clientId, docType, storagePath, contentSha256]) => ({
        id,
        tenantId: ids.lender,
        clientId,
        docType: docType as "FORM_20_PRE_AGREEMENT" | "CREDIT_AGREEMENT",
        fileUrl: "",
        fileName: path.basename(storagePath),
        mimeType: "application/pdf",
        storagePath,
        contentSha256,
        extractionStatus: "skipped",
      })),
    })
  })

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true })
    await db.documentAccessLog.deleteMany({ where: { documentId: { in: documentIds } } })
    await db.loanApplication.deleteMany({
      where: { id: { in: [ids.application, ids.crossPasq, ids.crossAgreement] } },
    })
    await db.clientDocument.deleteMany({ where: { id: { in: documentIds } } })
    await db.loanProduct.deleteMany({ where: { id: { in: [ids.product, ids.product2] } } })
    await db.client.deleteMany({
      where: { id: { in: [ids.owner, ids.neighbour, ids.outsider] } },
    })
    await db.tenant.deleteMany({ where: { id: { in: [ids.lender, ids.otherLender] } } })
    await db.$disconnect()
  })

  it("refuses everyone but the owner and logs nothing for them", async () => {
    const refused = [
      [await read(client(ids.neighbour, ids.lender)), 403],
      [await read(client(ids.outsider, ids.otherLender), slugs.otherLender), 404],
      [await read(client(ids.outsider, ids.otherLender)), 403],
      [await read(null), 401],
    ] as const
    for (const [res, status] of refused) expect(res.status).toBe(status)
    expect(await accessRows()).toEqual([])
  })

  it.each([
    ["PASQ", () => ids.crossPasq],
    ["credit agreement", () => ids.crossAgreement],
  ])("refuses a client's own application whose %s is another client's", async (_which, applicationId) => {
    const res = await read(client(ids.neighbour, ids.lender), slugs.lender, applicationId())
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "One or more signing-packet documents are unavailable." })
    expect(await accessRows()).toEqual([])
  })

  it("serves the owner and logs a read of both source documents", async () => {
    const res = await read(client(ids.owner, ids.lender))
    expect(res.status).toBe(200)
    const packet = await PDFDocument.load(await res.arrayBuffer())
    expect(packet.getPageCount()).toBe(5)
    const logged = { accessorType: "client", accessorId: ids.owner, action: "view_in_signing_packet" }
    expect(await accessRows()).toEqual([
      { documentId: ids.agreement, ...logged },
      { documentId: ids.pasq, ...logged },
    ])
  })
})
