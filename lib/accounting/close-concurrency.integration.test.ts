/**
 * A close queued behind a settings or mapping write plans from fresh settings. closePeriod runs at
 * REPEATABLE READ, so its snapshot is fixed when it starts, before it waits for the accounting lock;
 * without the row lock on AccountingSettings it would then close a month a concurrent write had just made
 * unclosable (a withdrawn mapping confirmation, a moved go-live month). Two connections: A holds the lock
 * and writes, B (closePeriod) waits behind A.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/close-concurrency.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { closePeriod } from "./generate"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-11-05T10:00:00+02:00")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function freshTenant(): Promise<ChargesTenant> {
  const tenant = await createChargesTenant(db, false)
  await createChargesLoan(db, tenant)
  await db.accountingSettings.create({ data: { tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
  return tenant
}

/** Holds the accounting lock on connection A, starts the close on B, waits until B is queued, then lets A write and commit. */
async function closeBehind(tenant: ChargesTenant, write: (tx: Pick<PrismaClient, "accountingSettings">) => Promise<unknown>) {
  let started: Promise<unknown> | null = null
  const closing = new Promise<unknown>((resolve) => {
    void db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('accounting-export:${tenant.tenantId}'))`)
      started = runWithTenant(tenant.tenantId, () => closePeriod(prisma, { tenantId: tenant.tenantId, periodKey: "2026-08", userId: tenant.userId, userEmail: "race@test.invalid", now: AFTER }))
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      for (let i = 0; i < 200; i += 1) {
        const waiting = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        if (Number(waiting[0].n) > 0) break
        await sleep(25)
      }
      await sleep(150) // B has its snapshot and is waiting: now the write
      await write(tx)
    }).then(() => resolve(started))
  })
  return (await (await closing)) as { value?: { created: boolean }; error?: { code?: string } }
}

suite.sequential("a close waiting behind a settings write (real Postgres)", () => {
  afterAll(async () => { await db.$disconnect() })

  it("does not close a month whose mapping confirmation was withdrawn while it waited", async () => {
    const tenant = await freshTenant()
    const result = await closeBehind(tenant, (tx) => tx.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { mappingConfirmedAt: null } }))
    expect(result.error, JSON.stringify(result)).toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
    expect(await db.accountingExportBatch.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  }, 60_000)

  it("does not close a month that is no longer the go-live month once the go-live month moved while it waited", async () => {
    const tenant = await freshTenant()
    const result = await closeBehind(tenant, (tx) => tx.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { goLiveMonth: "2026-09" } }))
    expect(result.error, JSON.stringify(result)).toMatchObject({ code: "OUT_OF_ORDER" })
    expect(await db.accountingExportBatch.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  }, 60_000)

  it("still closes when nothing changed while it waited", async () => {
    const tenant = await freshTenant()
    const result = await closeBehind(tenant, (tx) => tx.accountingSettings.findUnique({ where: { tenantId: tenant.tenantId } }))
    expect(result.value, JSON.stringify(result)).toMatchObject({ created: true })
  }, 60_000)
})
