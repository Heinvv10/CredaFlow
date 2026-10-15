/**
 * A close queued behind a settings or mapping write plans from fresh settings. closePeriod runs at
 * REPEATABLE READ, so its snapshot is fixed when it starts, before it waits for the accounting lock;
 * without the row lock on AccountingSettings it would then close a month a concurrent write had just made
 * unclosable (a withdrawn mapping confirmation, a moved go-live month). Two connections: A holds the lock
 * and writes, B (closePeriod) waits behind A. One case queues the real mapping PUT route ahead of the close.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/close-concurrency.integration.test.ts
 */
import { Prisma, PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, describe, expect, it, vi } from "vitest"

const current = vi.hoisted(() => ({ tenantId: "", userId: "" }))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: current.userId, email: "route@test.invalid", totpVerified: true } })) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: vi.fn(async () => false) }))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant")>()
  const { runWithTenant: inTenant } = await import("@/lib/tenant-scope")
  return { ...real, withTenantContext: (_req: unknown, run: (t: { id: string }) => Promise<unknown>) => inTenant(current.tenantId, () => run({ id: current.tenantId })) }
})

import { PUT as putMappings } from "@/app/api/accounting/mappings/route"
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
  current.tenantId = tenant.tenantId
  current.userId = tenant.userId
  return tenant
}

const closeAug = (tenant: ChargesTenant, client: Pick<typeof prisma, "$transaction" | "accountingExportBatch"> = prisma) =>
  runWithTenant(tenant.tenantId, () => closePeriod(client as typeof prisma, { tenantId: tenant.tenantId, periodKey: "2026-08", userId: tenant.userId, userEmail: "race@test.invalid", now: AFTER }))
    .then((value) => ({ value }), (error: unknown) => ({ error: error as { code?: string } }))

/**
 * Connection A takes the accounting lock (the very key closePeriod and the settings routes take). `queue` starts the
 * work that must wait behind it, resolving each time `waiting` queued lockers have appeared; then A runs `write` and commits.
 */
async function behindTheLock(tenant: ChargesTenant, queue: (waitFor: (n: number) => Promise<void>) => Promise<void>, write: (tx: Pick<PrismaClient, "accountingSettings">) => Promise<unknown>) {
  const key = `accounting-export:${tenant.tenantId}`
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let locked!: () => void
  const lockTaken = new Promise<void>((resolve) => { locked = resolve })
  const a = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${key}'))`)
    locked()
    await held
    await write(tx)
  }, { timeout: 30_000 })
  await lockTaken
  // advisory lock keys are (classid, objid): hashtext is an int4, sign-extended, its low 32 bits are objid
  const waiting = async () => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND objid::bigint = (hashtext('${key}')::bigint & 4294967295)`,
  ))[0].n)
  const waitFor = async (n: number) => { for (let i = 0; i < 400 && (await waiting()) < n; i += 1) await sleep(25); await sleep(100) }
  await queue(waitFor)
  release()
  await a
}

suite.sequential("a close waiting behind a settings write (real Postgres)", () => {
  afterAll(async () => { await db.$disconnect() })

  const race = async (tenant: ChargesTenant, write: (tx: Pick<PrismaClient, "accountingSettings">) => Promise<unknown>) => {
    let closing!: ReturnType<typeof closeAug>
    await behindTheLock(tenant, async (waitFor) => { closing = closeAug(tenant); await waitFor(1) }, write)
    return closing
  }

  it("does not close a month whose mapping confirmation was withdrawn while it waited", async () => {
    const tenant = await freshTenant()
    const result = await race(tenant, (tx) => tx.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { mappingConfirmedAt: null } }))
    expect(result, JSON.stringify(result)).toMatchObject({ error: { code: "MAPPING_NOT_CONFIRMED" } })
    expect(await db.accountingExportBatch.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  }, 60_000)

  it("does not close a month that is no longer the go-live month once the go-live month moved while it waited", async () => {
    const tenant = await freshTenant()
    const result = await race(tenant, (tx) => tx.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { goLiveMonth: "2026-09" } }))
    expect(result, JSON.stringify(result)).toMatchObject({ error: { code: "OUT_OF_ORDER" } })
    expect(await db.accountingExportBatch.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  }, 60_000)

  it("still closes when nothing changed while it waited", async () => {
    const tenant = await freshTenant()
    const result = await race(tenant, (tx) => tx.accountingSettings.findUnique({ where: { tenantId: tenant.tenantId } }))
    expect(result, JSON.stringify(result)).toMatchObject({ value: { created: true } })
  }, 60_000)

  it("the real mapping PUT route queued ahead of the close withdraws the confirmation, and the close refuses on it", async () => {
    const tenant = await freshTenant()
    let put!: Promise<Response>
    let closing!: ReturnType<typeof closeAug>
    await behindTheLock(tenant, async (waitFor) => {
      put = putMappings(new NextRequest("http://x.invalid/api/accounting/mappings", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mappings: [{ role: "BANK", accountCode: "1001" }] }),
      }))
      await waitFor(1)
      closing = closeAug(tenant)
      await waitFor(2)
      // The route is parked behind the lock too: its write has not happened (a route that skipped the lock would already be done).
      expect(await Promise.race([put.then(() => "done"), sleep(300).then(() => "waiting")])).toBe("waiting")
    }, async () => undefined)
    expect((await put).status).toBe(200)
    expect(await closing, "the close waited behind the route's write and planned from its result").toMatchObject({ error: { code: "MAPPING_NOT_CONFIRMED" } })
    expect(await db.accountingExportBatch.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  }, 60_000)

  it("answers CONCURRENT_CHANGE after three attempts that all conflict, and tried exactly three times", async () => {
    const tenant = await freshTenant()
    let attempts = 0
    const conflict = () => new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: Prisma.prismaVersion.client })
    const alwaysConflicting = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key)
        return (fn: (tx: unknown) => Promise<unknown>, options: unknown) => (target.$transaction as (f: unknown, o: unknown) => Promise<unknown>)((tx: object) => {
          attempts += 1
          return fn(new Proxy(tx, { get: (t, k) => (k === "$queryRaw" ? () => { throw conflict() } : Reflect.get(t, k)) }))
        }, options)
      },
    }) as typeof prisma
    expect(await closeAug(tenant, alwaysConflicting)).toMatchObject({ error: { code: "CONCURRENT_CHANGE" } })
    expect(attempts).toBe(3)
    expect(await db.accountingExportBatch.count({ where: { tenantId: tenant.tenantId } })).toBe(0)
  }, 60_000)
})
