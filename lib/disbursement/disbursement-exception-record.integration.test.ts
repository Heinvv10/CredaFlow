/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_DISBURSEMENT_EXCEPTION_RECORD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/disbursement/disbursement-exception-record.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"

const suite = process.env.RUN_DISBURSEMENT_EXCEPTION_RECORD_IT === "1"
  ? describe
  : describe.skip

// The dropped outage trigger refused every DISBURSEMENT_EXCEPTION record;
// ComplianceRecord_no_disbursement_exception keeps that refusal. Both raise
// SQLSTATE 23514, so this passes before and after the migration.
suite("DISBURSEMENT_EXCEPTION compliance records stay impossible", () => {
  const checkViolation = /Code: `23514`/

  async function createTenant() {
    const tenantId = `tenant_disb_exception_${randomUUID().replaceAll("-", "")}`
    await prisma.tenant.create({ data: { id: tenantId, slug: tenantId, name: "Disbursement exception guard" } })
    return tenantId
  }

  function insertRecord(tenantId: string, type: "DISBURSEMENT_EXCEPTION" | "FAIS_DISCLOSURE") {
    const id = `compliance_${randomUUID()}`
    return prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ComplianceRecord" ("id", "tenantId", "type", "status", "updatedAt")
      VALUES (${id}, ${tenantId}, ${type}::"ComplianceType", 'PENDING'::"ComplianceStatus", NOW())
    `).then(() => id)
  }

  it("refuses an INSERT of a DISBURSEMENT_EXCEPTION record", async () => {
    const tenantId = await createTenant()
    await expect(insertRecord(tenantId, "DISBURSEMENT_EXCEPTION")).rejects.toThrow(checkViolation)
    // Control: the same insert of another type is accepted.
    await expect(insertRecord(tenantId, "FAIS_DISCLOSURE")).resolves.toMatch(/^compliance_/)
  })

  it("refuses an UPDATE that turns a record into a DISBURSEMENT_EXCEPTION", async () => {
    const tenantId = await createTenant()
    const id = await insertRecord(tenantId, "FAIS_DISCLOSURE")
    await expect(prisma.$executeRaw(Prisma.sql`
      UPDATE "ComplianceRecord" SET "type" = 'DISBURSEMENT_EXCEPTION'::"ComplianceType" WHERE "id" = ${id}
    `)).rejects.toThrow(checkViolation)
  })
})

