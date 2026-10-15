/**
 * Real-Postgres proof that the STR audit filter (lib/fic/audit-visibility.ts)
 * means what the readers rely on: a LOAN_ADMIN's where clause returns no STR
 * row by entity or by action, and keeps every other row; the FIC compliance
 * role sees all of them.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/fic/audit-visibility.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { withStrAuditVisibility } from "./audit-visibility"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()
const t = `tenant_auditvis_${randomUUID().slice(0, 8)}`

suite("STR audit visibility against Postgres", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: t, slug: t, name: "Audit visibility" } })
    await db.auditLog.createMany({ data: [
      { tenantId: t, action: "STR_CASE_RAISED", entity: "SuspiciousReportCase", entityId: "case-1" },
      { tenantId: t, action: "STR_CASE_UPDATED", entity: "Somewhere", entityId: "case-1" },
      { tenantId: t, action: "FIC_EXPORTED", entity: "SuspiciousReportCase" },
      { tenantId: t, action: "FIC_EXPORTED", entity: "CashThresholdReport" },
      { tenantId: t, action: "LOAN_APPROVED", entity: "LoanApplication", entityId: "app-1" },
    ] })
  })
  afterAll(async () => db.$disconnect())

  it("returns no STR row to a LOAN_ADMIN and every other row", async () => {
    const rows = await db.auditLog.findMany({ where: withStrAuditVisibility({ tenantId: t }, "LOAN_ADMIN"), select: { action: true, entity: true } })
    expect(rows.map((r) => `${r.action}:${r.entity}`).sort()).toEqual(["FIC_EXPORTED:CashThresholdReport", "LOAN_APPROVED:LoanApplication"])
    expect(await db.auditLog.count({ where: withStrAuditVisibility({ tenantId: t, entity: "SuspiciousReportCase" }, "LOAN_ADMIN") })).toBe(0)
  })

  it("returns every row to the FIC compliance role", async () => {
    expect(await db.auditLog.count({ where: withStrAuditVisibility({ tenantId: t }, "ADMIN") })).toBe(5)
  })
})
