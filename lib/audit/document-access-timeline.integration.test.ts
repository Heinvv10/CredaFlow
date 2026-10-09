/**
 * Real-Postgres proof for POPIA tenant isolation and export filters.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/document-access-timeline.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { readTenantDocumentAccess } from "./document-access-timeline"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("document access tenant isolation", () => {
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const ids = {
    tenantA: `tenant_access_a_${token}`,
    tenantB: `tenant_access_b_${token}`,
    clientA: `client_access_a_${token}`,
    clientB: `client_access_b_${token}`,
    documentA: `document_access_a_${token}`,
    documentB: `document_access_b_${token}`,
    accessA: `access_a_${token}`,
    accessB: `access_b_${token}`,
  }
  const accessedAt = new Date("2026-07-20T08:05:00.000Z")

  beforeAll(async () => {
    await db.tenant.createMany({
      data: [
        { id: ids.tenantA, slug: `access-a-${token}`, name: "Access Tenant A" },
        { id: ids.tenantB, slug: `access-b-${token}`, name: "Access Tenant B" },
      ],
    })
    await db.client.createMany({
      data: [
        {
          id: ids.clientA,
          tenantId: ids.tenantA,
          reference: `CLI-ACCESS-A-${token}`,
          idNumber: `ACCESS-A-${token}`,
          firstName: "Synthetic",
          lastName: "Access A",
          email: `access-a-${token}@test.invalid`,
          phone: "+27820000021",
        },
        {
          id: ids.clientB,
          tenantId: ids.tenantB,
          reference: `CLI-ACCESS-B-${token}`,
          idNumber: `ACCESS-B-${token}`,
          firstName: "Synthetic",
          lastName: "Access B",
          email: `access-b-${token}@test.invalid`,
          phone: "+27820000022",
        },
      ],
    })
    await db.clientDocument.createMany({
      data: [
        {
          id: ids.documentA,
          tenantId: ids.tenantA,
          clientId: ids.clientA,
          docType: "OTHER",
          fileUrl: "",
          fileName: "tenant-a.pdf",
        },
        {
          id: ids.documentB,
          tenantId: ids.tenantB,
          clientId: ids.clientB,
          docType: "OTHER",
          fileUrl: "",
          fileName: "tenant-b.pdf",
        },
      ],
    })
    await db.documentAccessLog.createMany({
      data: [
        {
          id: ids.accessA,
          documentId: ids.documentA,
          accessorType: "staff",
          accessorId: "shared-staff-id",
          action: "download",
          createdAt: accessedAt,
        },
        {
          id: ids.accessB,
          documentId: ids.documentB,
          accessorType: "staff",
          accessorId: "shared-staff-id",
          action: "download",
          createdAt: accessedAt,
        },
      ],
    })
  })

  afterAll(async () => {
    await db.documentAccessLog.deleteMany({
      where: { documentId: { in: [ids.documentA, ids.documentB] } },
    })
    await db.clientDocument.deleteMany({
      where: { id: { in: [ids.documentA, ids.documentB] } },
    })
    await db.client.deleteMany({
      where: { id: { in: [ids.clientA, ids.clientB] } },
    })
    await db.tenant.deleteMany({
      where: { id: { in: [ids.tenantA, ids.tenantB] } },
    })
    await db.$disconnect()
  })

  it("returns only the requested tenant after applying staff, search, and date filters", async () => {
    const rows = await readTenantDocumentAccess(db, ids.tenantA, {
      from: new Date("2026-07-20T00:00:00.000Z"),
      to: new Date("2026-07-20T23:59:59.999Z"),
      staffUserId: "shared-staff-id",
      search: "DOCUMENT_DOWNLOAD",
      limit: 100,
    })

    expect(rows.map((row) => row.documentId)).toEqual([ids.documentA])
  })
})
