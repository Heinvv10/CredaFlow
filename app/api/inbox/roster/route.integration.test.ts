/**
 * Real-Postgres proof that PATCH /api/inbox/roster flips exactly one user, in
 * the caller's tenant, and never one who outranks the caller. A JSON
 * object in `userId` is a Prisma filter, not an id: `{"in": [...]}` would let
 * the role check see one row while updateMany flips every match. A mocked
 * Prisma cannot show what a filter matches.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/inbox/roster/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient, type UserRole } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_roster_ceiling_${token}`
const slug = `roster-ceiling-${token}`
const ids = {
  admin: `user_roster_admin_${token}`,
  officer: `user_roster_officer_${token}`,
  root: `user_roster_root_${token}`,
  promoted: `user_roster_promoted_${token}`,
}

const h = vi.hoisted(() => ({
  /** Runs once, right after the route's first read of the member. */
  afterTargetRead: null as null | (() => Promise<unknown>),
}))

// The session is the only seam mocked; requireApiRole, the write gate,
// withTenantContext and the audit writer are the real ones.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: ids.admin, email: `${ids.admin}@test.invalid`, name: null, role: "ADMIN", tenantId, totpVerified: true, tokenVersion: 0 } }),
}))

// The real client, with a hook after `user.findFirst` — the read the route's
// first role check is made on — to inject a change before the write.
vi.mock("@/lib/prisma", async (importOriginal) => {
  const { prisma } = await importOriginal<typeof import("@/lib/prisma")>()
  const user = new Proxy(prisma.user, {
    get: (target, key) => key !== "findFirst" ? Reflect.get(target, key) : async (args: Parameters<typeof target.findFirst>[0]) => {
      const row = await target.findFirst(args)
      const hook = h.afterTargetRead
      h.afterTargetRead = null
      await hook?.()
      return row
    },
  })
  return { prisma: new Proxy(prisma, { get: (target, key) => key === "user" ? user : Reflect.get(target, key) }) }
})

import { PATCH } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("PATCH /api/inbox/roster (real database)", () => {
  const db = new PrismaClient()

  const toggle = (userId: unknown) => PATCH(new NextRequest("http://localhost/api/inbox/roster", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-tenant-slug": slug },
    body: JSON.stringify({ userId, isCommsAgent: true }),
  }))

  const flags = async () => Object.fromEntries(
    (await db.user.findMany({ where: { tenantId }, select: { id: true, isCommsAgent: true } })).map((u) => [u.id, u.isCommsAgent]),
  )

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug, name: "Roster Ceiling Integration Test" } })
    // Insertion order matters to the probe below: the low-ranked row comes
    // first, so an unordered findFirst over a filter sees it, not the senior one.
    for (const [id, role] of [[ids.officer, "CREDIT_OFFICER"], [ids.root, "SUPER_ADMIN"], [ids.admin, "ADMIN"], [ids.promoted, "CREDIT_OFFICER"]] as const) {
      await db.user.create({ data: { id, tenantId, role: role as UserRole, email: `${id}@test.invalid`, password: "not-a-login-credential" } })
    }
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it.each([
    ["an `in` filter", { in: [ids.officer, ids.root] }],
    ["a `startsWith` filter", { startsWith: "user_roster_" }],
    ["a `not` filter", { not: ids.admin }],
  ])("rejects %s as a userId with 400 and flips nobody", async (_label, userId) => {
    const before = await flags()
    const res = await toggle(userId)

    expect(res.status).toBe(400)
    expect(await flags()).toEqual(before)
  })

  it("refuses toggling a SUPER_ADMIN and leaves the flag as it was", async () => {
    const res = await toggle(ids.root)

    expect(res.status).toBe(403)
    expect((await flags())[ids.root]).toBe(false)
  })

  // The toggle re-checks on the row its transaction locks.
  it("refuses a member promoted to SUPER_ADMIN between the check and the write, and leaves the flag", async () => {
    h.afterTargetRead = () => db.user.update({ where: { id: ids.promoted }, data: { role: "SUPER_ADMIN" } })
    const res = await toggle(ids.promoted)

    expect(res.status).toBe(403)
    expect((await flags())[ids.promoted]).toBe(false)
    expect(await db.auditLog.count({ where: { tenantId, action: "USER_WRITE_REFUSED", entityId: ids.promoted } })).toBe(1)
  })

  it("flips exactly the one permitted user, with its audit row", async () => {
    const res = await toggle(ids.officer)

    expect(res.status).toBe(200)
    expect(await flags()).toEqual({ [ids.officer]: true, [ids.root]: false, [ids.admin]: false, [ids.promoted]: false })
    expect(await db.auditLog.count({ where: { tenantId, action: "USER_UPDATED", entityId: ids.officer, userId: ids.admin } })).toBe(1)
  })
})
