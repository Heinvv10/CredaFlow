/**
 * Real-Postgres proof that the nightly arrears snapshot runs through its route
 * for EVERY tenant: with two real lenders, one call writes each lender's loans
 * under its own tenant, plus each lender's run marker; a second call the same
 * day writes nothing. Nothing is stubbed: the Prisma tenant-scope extension
 * and the cron secret check are the real ones (the first version listed
 * tenants through Loan outside a tenant frame and threw missing-context on
 * every run).
 *
 *   RUN_ARREARS_HISTORY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/cron/arrears-snapshot/route.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GET } from "./route"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { snapshotDay } from "@/lib/reports/arrears-snapshot"

const suite = process.env.RUN_ARREARS_HISTORY_IT === "1" ? describe.sequential : describe.skip
// Assertions read through a plain client, so they see the database.
const db = new PrismaClient()
const CRON_SECRET = "arrears-snapshot-it-cron-secret"

const call = () => GET(new NextRequest("http://localhost/api/cron/arrears-snapshot", { headers: { "x-cron-secret": CRON_SECRET } }))

suite("GET /api/cron/arrears-snapshot across tenants", () => {
  const lenders: Array<{ tenantId: string; loanIds: string[] }> = []
  const saved = process.env.CRON_SECRET

  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET
    for (const loans of [2, 1]) {
      const tenant = await createChargesTenant(db, false)
      const loanIds: string[] = []
      for (let i = 0; i < loans; i++) loanIds.push((await createChargesLoan(db, tenant)).loanId)
      lenders.push({ tenantId: tenant.tenantId, loanIds })
    }
    // A lender with no collectible loan: the run still records the day.
    lenders.push({ tenantId: (await createChargesTenant(db, false)).tenantId, loanIds: [] })
  }, 60_000)

  afterAll(async () => {
    if (saved === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = saved
    await db.$disconnect()
  })

  it("snapshots each lender's own loans under its own tenant, and marks each lender's day", async () => {
    const res = await call()
    // Other suites' tenants share this database; ours must have succeeded.
    expect(res.status).not.toBe(500)
    const body = await res.json() as { perTenant: Array<{ tenantId: string; loans?: number; error?: string }> }
    const today = snapshotDay(new Date())
    for (const lender of lenders) {
      expect(body.perTenant.find((t) => t.tenantId === lender.tenantId)).toMatchObject({ loans: lender.loanIds.length })
      const rows = await db.loanArrearsSnapshot.findMany({ where: { loanId: { in: lender.loanIds.length ? lender.loanIds : ["-"] } } })
      expect(rows.map((r) => r.loanId).sort()).toEqual([...lender.loanIds].sort())
      expect(rows.every((r) => r.tenantId === lender.tenantId && r.snapshotDate.getTime() === today.getTime())).toBe(true)
      expect(await db.arrearsSnapshotRun.findMany({ where: { tenantId: lender.tenantId }, select: { loanCount: true } }))
        .toEqual([{ loanCount: lender.loanIds.length }])
    }
  // The route walks EVERY tenant in the database, and the integration
  // database holds every earlier suite's lenders.
  }, 120_000)

  it("writes nothing on a second run the same day", async () => {
    const before = await db.loanArrearsSnapshot.count({ where: { tenantId: { in: lenders.map((l) => l.tenantId) } } })
    const res = await call()
    expect(res.status).not.toBe(500)
    const body = await res.json() as { perTenant: Array<{ tenantId: string; written?: number }> }
    for (const lender of lenders) expect(body.perTenant.find((t) => t.tenantId === lender.tenantId)).toMatchObject({ written: 0 })
    expect(await db.loanArrearsSnapshot.count({ where: { tenantId: { in: lenders.map((l) => l.tenantId) } } })).toBe(before)
  }, 120_000)

  it("refuses a call without the cron secret", async () => {
    const res = await GET(new NextRequest("http://localhost/api/cron/arrears-snapshot"))
    expect(res.status).toBe(401)
  })
})
