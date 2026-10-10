/**
 * Real-Postgres proof that two concurrent colour PATCHes cannot commit a
 * palette that fails WCAG AA. Each request changes a DIFFERENT colour; each
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
import { tenantColourErrors, type TenantColours } from "@/lib/theme/tenant-colours"

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }))

import { PATCH } from "./route"

const RUN = process.env.RUN_TENANT_COLOUR_RACE_IT === "1"
const suite = RUN ? describe : describe.skip

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_colour_race_${token}`

const BASE: TenantColours = { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" }
// Each passes alone against BASE; together they fail: a near-black primary
// (#000044) is unreadable as text on the #181818 dark surface.
const A = { primaryColor: "#000044" }
const B = { darkColor: "#181818" }

const patch = (body: unknown) => PATCH(
  new NextRequest(`http://localhost/api/admin/tenants/${tenantId}`, {
    method: "PATCH", headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ tenantId }) },
)

suite("PATCH /api/admin/tenants/[tenantId] concurrent colour writes", () => {
  const db = new PrismaClient()
  const blocker = new PrismaClient()

  beforeAll(async () => {
    process.env.ADMIN_SECRET = "s3cret"
    authMock.mockResolvedValue({ user: { email: "root@test.invalid", role: "SUPER_ADMIN" } })
    await db.tenant.create({ data: { id: tenantId, slug: `colour-race-${token}`, name: "Colour Race Test" } })
    await db.tenantConfig.create({ data: { tenantId, ...BASE } })
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
    await blocker.$disconnect()
  })

  const lockWaiters = async () => {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`
    return Number(rows[0].n)
  }

  it("commits one change and refuses the other with 422", async () => {
    // Precondition, so the race below cannot pass vacuously.
    expect(tenantColourErrors({ ...BASE, ...A })).toEqual({})
    expect(tenantColourErrors({ ...BASE, ...B })).toEqual({})
    expect(Object.keys(tenantColourErrors({ ...BASE, ...A, ...B })).length).toBeGreaterThan(0)

    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => { locked = resolve })
    const hold = blocker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`
      locked()
      await released
    }, { timeout: 60_000 })
    await lockTaken

    let settled = 0
    const fire = (body: unknown) => patch(body).finally(() => { settled++ })
    const first = fire(A)
    const second = fire(B)

    // With the lock in place both requests queue on it. Without it they never
    // wait on the Tenant row (they have already validated against the old
    // set), so stop waiting once both have settled or after 5 s, whichever
    // comes first; the assertions below then decide.
    const deadline = Date.now() + 5_000
    while (settled < 2 && Date.now() < deadline && (await lockWaiters()) < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    release()
    await hold
    const responses = await Promise.all([first, second])

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
})
