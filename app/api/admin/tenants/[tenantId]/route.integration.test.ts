/**
 * Real-Postgres proof that two concurrent colour PATCHes cannot commit a
 * palette that fails WCAG AA, and that the same holds when the tenant has no
 * TenantConfig row yet (the nested upsert create path). Each request changes a DIFFERENT colour; each
 * passes alone against the saved set, together they fail. The route must
 * serialise them on the Tenant row lock and validate the second against the
 * first's commit.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_TENANT_COLOUR_RACE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run "app/api/admin/tenants/[tenantId]/route.integration.test.ts"
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { DEFAULT_TENANT_COLOURS, tenantColourErrors, type TenantColours } from "@/lib/theme/tenant-colours"

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }))

import { PATCH } from "./route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_TENANT_COLOUR_RACE_IT === "1"
const suite = RUN ? describe : describe.skip

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_colour_race_${token}`
const bareTenantId = `tenant_colour_bare_${token}`

const BASE: TenantColours = { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" }
// Each passes alone against BASE; together they fail: a near-black primary
// (#000044) is unreadable as text on the #181818 dark surface.
const A = { primaryColor: "#000044" }
const B = { darkColor: "#181818" }

const patch = (id: string, body: unknown) => PATCH(
  new NextRequest(`http://localhost/api/admin/tenants/${id}`, {
    method: "PATCH", headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ tenantId: id }) },
)

suite("PATCH /api/admin/tenants/[tenantId] concurrent colour writes", () => {
  const db = new PrismaClient()
  const blocker = new PrismaClient()

  beforeAll(async () => {
    process.env.ADMIN_SECRET = "s3cret"
    authMock.mockResolvedValue({ user: { email: "root@test.invalid", role: "SUPER_ADMIN" } })
    await db.tenant.create({ data: { id: tenantId, slug: `colour-race-${token}`, name: "Colour Race Test" } })
    await db.tenantConfig.create({ data: { tenantId, ...BASE } })
    await db.tenant.create({ data: { id: bareTenantId, slug: `colour-bare-${token}`, name: "Colour Bare Test" } })
  })

  afterAll(async () => {
    for (const id of [tenantId, bareTenantId]) {
      await purgeAuditRowsForTest(db, { tenantId: id })
      await db.tenantConfig.deleteMany({ where: { tenantId: id } })
      await db.tenant.delete({ where: { id } })
    }
    await db.$disconnect()
    await blocker.$disconnect()
  })

  const lockWaiters = async () => {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`
    return Number(rows[0].n)
  }

  // Fires the bodies as concurrent PATCHes while another transaction holds the
  // route's own lock (FOR NO KEY UPDATE on the Tenant row), then releases it.
  //
  // With the route lock, each request blocks on it once it reaches its
  // SELECT ... FOR NO KEY UPDATE, so two lock waiters appear in
  // pg_stat_activity. Without it the requests do not wait on the blocker at
  // all (NO KEY UPDATE does not conflict with the FOR KEY SHARE that the
  // AuditLog insert takes), so both run to completion at once and settle.
  // The poll therefore exits on whichever comes first: both requests settled,
  // two lock waiters, or the 5 s deadline. That is enough for the assertions
  // to decide: with the lock, release() lets the requests run one after the
  // other and the second validates against the first's commit; without it,
  // both have already validated against the old set before release() and the
  // assertions on status codes and the committed palette fail.
  const raceBehindBlocker = async (id: string, bodies: unknown[]) => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => { locked = resolve })
    const hold = blocker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE id = ${id} FOR NO KEY UPDATE`
      locked()
      await released
    }, { timeout: 60_000 })
    await lockTaken

    let settled = 0
    const requests = bodies.map((body) => patch(id, body).finally(() => { settled++ }))

    const deadline = Date.now() + 5_000
    while (settled < bodies.length && Date.now() < deadline && (await lockWaiters()) < bodies.length) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    release()
    await hold
    return Promise.all(requests)
  }

  it("commits one change and refuses the other with 422", async () => {
    // Precondition, so the race below cannot pass vacuously.
    expect(tenantColourErrors({ ...BASE, ...A })).toEqual({})
    expect(tenantColourErrors({ ...BASE, ...B })).toEqual({})
    expect(Object.keys(tenantColourErrors({ ...BASE, ...A, ...B })).length).toBeGreaterThan(0)

    const responses = await raceBehindBlocker(tenantId, [A, B])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 422])
    const winnerIndex = responses[0].status === 200 ? 0 : 1
    const winner = [A, B][winnerIndex] as Partial<TenantColours>
    const [key] = Object.keys(winner) as (keyof TenantColours)[]

    const config = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } })
    const committed = { primaryColor: config.primaryColor, secondaryColor: config.secondaryColor, darkColor: config.darkColor }
    expect(tenantColourErrors(committed)).toEqual({})
    expect(committed).toEqual({ ...BASE, ...winner })

    const audits = await db.auditLog.findMany({ where: { tenantId, action: "TENANT_COLOURS_UPDATED" } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      entity: "TenantConfig", entityId: tenantId,
      oldValue: { [key]: BASE[key] }, newValue: { [key]: winner[key] },
    })

    const loser = await responses[1 - winnerIndex].json()
    expect(loser.error).toBe("Tenant colours fail validation")
  })

  it("applies both changes when the tenant has no TenantConfig row yet", async () => {
    // Each is valid alone and together against the defaults a missing row falls back to.
    const primary = { primaryColor: "#1F4E79" }
    const secondary = { secondaryColor: "#245E92" }
    expect(DEFAULT_TENANT_COLOURS.primaryColor).not.toBe(primary.primaryColor)
    expect(DEFAULT_TENANT_COLOURS.secondaryColor).not.toBe(secondary.secondaryColor)
    expect(tenantColourErrors({ ...DEFAULT_TENANT_COLOURS, ...primary })).toEqual({})
    expect(tenantColourErrors({ ...DEFAULT_TENANT_COLOURS, ...secondary })).toEqual({})
    expect(tenantColourErrors({ ...DEFAULT_TENANT_COLOURS, ...primary, ...secondary })).toEqual({})
    expect(await db.tenantConfig.count({ where: { tenantId: bareTenantId } })).toBe(0)

    const responses = await raceBehindBlocker(bareTenantId, [primary, secondary])

    expect(responses.map((r) => r.status)).toEqual([200, 200])
    const configs = await db.tenantConfig.findMany({ where: { tenantId: bareTenantId } })
    expect(configs).toHaveLength(1)
    const committed = { primaryColor: configs[0].primaryColor, secondaryColor: configs[0].secondaryColor, darkColor: configs[0].darkColor }
    expect(tenantColourErrors(committed)).toEqual({})
    // darkColor was never sent: it is the column default, which is upper-case in the schema.
    expect(committed).toEqual({ ...primary, ...secondary, darkColor: committed.darkColor })
    expect(committed.darkColor.toLowerCase()).toBe(DEFAULT_TENANT_COLOURS.darkColor.toLowerCase())

    const audits = await db.auditLog.findMany({ where: { tenantId: bareTenantId, action: "TENANT_COLOURS_UPDATED" } })
    expect(audits).toHaveLength(2)
  })
})
