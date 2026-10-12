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
    pasq: `document_packet_pasq_${token}`,
    agreement: `document_packet_agreement_${token}`,
  }
  const slugs = { lender: `packet-a-${token}`, otherLender: `packet-b-${token}` }
  let storageDir: string

  const client = (id: string, tenantId: string): Session => ({
    user: { id, email: `${id}@test.invalid`, role: "CLIENT", tenantId },
  })

  /** `slug` is the lender whose deployment the request arrives at. */
  function read(session: Session, slug = slugs.lender): Promise<Response> {
    authState.session = session
    const req = new NextRequest(
      `http://portal.test.invalid/api/applications/${ids.application}/signing-packet`,
      { headers: { "x-tenant-slug": slug } },
    )
    return GET(req, { params: Promise.resolve({ id: ids.application }) }) as Promise<Response>
  }

  const accessRows = () =>
    db.documentAccessLog.findMany({
      where: { documentId: { in: [ids.pasq, ids.agreement] } },
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
    await db.loanProduct.create({
      data: {
        id: ids.product,
        tenantId: ids.lender,
        code: `PACKET-${token}`,
        name: "Packet product",
        productType: "PERSONAL",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
      },
    })
    const generatedAt = new Date("2026-10-01T08:00:00.000Z")
    const evidenceSha256 = "b".repeat(64)
    await db.loanApplication.create({
      data: {
        id: ids.application,
        tenantId: ids.lender,
        reference: `APP-PACKET-${token}`,
        clientId: ids.owner,
        productId: ids.product,
        appliedAmount: 500_000,
        appliedTermDays: 30,
        status: "UNDER_REVIEW",
        pasqVersion: "pasq-v3",
        pasqGeneratedAt: generatedAt,
        pasqDocumentId: ids.pasq,
        pasqDocumentSha256: sha(pasq),
        pasqEvidence: {
          version: "pasq-v3",
          tenantId: ids.lender,
          applicationId: ids.application,
          clientId: ids.owner,
          productId: ids.product,
          evidenceSha256,
        },
        pasqEvidenceSha256: evidenceSha256,
        agreementGeneratedAt: generatedAt,
        agreementDocumentId: ids.agreement,
        agreementDocumentSha256: sha(agreement),
      },
    })
    await db.clientDocument.createMany({
      data: [
        {
          id: ids.pasq,
          tenantId: ids.lender,
          clientId: ids.owner,
          docType: "FORM_20_PRE_AGREEMENT",
          fileUrl: `/api/applications/${ids.application}/pasq`,
          fileName: "pasq.pdf",
          mimeType: "application/pdf",
          storagePath: pasqPath,
          contentSha256: sha(pasq),
          extractionStatus: "skipped",
        },
        {
          id: ids.agreement,
          tenantId: ids.lender,
          clientId: ids.owner,
          docType: "CREDIT_AGREEMENT",
          fileUrl: `/api/applications/${ids.application}/agreement`,
          fileName: "agreement.pdf",
          mimeType: "application/pdf",
          storagePath: agreementPath,
          contentSha256: sha(agreement),
          extractionStatus: "skipped",
        },
      ],
    })
  })

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true })
    await db.documentAccessLog.deleteMany({
      where: { documentId: { in: [ids.pasq, ids.agreement] } },
    })
    await db.loanApplication.deleteMany({ where: { id: ids.application } })
    await db.clientDocument.deleteMany({ where: { id: { in: [ids.pasq, ids.agreement] } } })
    await db.loanProduct.deleteMany({ where: { id: ids.product } })
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
