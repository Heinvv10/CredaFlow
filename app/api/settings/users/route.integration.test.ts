/**
 * Real-Postgres proof of the staff-user role ceiling and tenant boundary on
 * POST /api/settings/users and PATCH /api/settings/users/[id]: a refused write
 * leaves the stored row untouched, and another tenant's user cannot be reached
 * by id. `User` is not a tenant-scoped model (lib/tenant-scope.ts), so the
 * routes' own `tenantId` filter is the only thing between two lenders' staff —
 * a mocked Prisma cannot show that it holds.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/settings/users/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient, type UserRole } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantA = `tenant_role_ceiling_a_${token}`
const tenantB = `tenant_role_ceiling_b_${token}`
const slugA = `role-ceiling-a-${token}`
const slugB = `role-ceiling-b-${token}`
const emailOf = (name: string) => `${name}-${token}@test.invalid`

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))

// The session is the only seam mocked. requireApiRole, the write gate,
// withTenantContext (which binds the session's tenant to the request's) and
// the audit writer are the real ones, against the real database.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { POST } from "./route"
import { PATCH } from "./[id]/route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("staff-user role ceiling and tenant boundary (real database)", () => {
  const db = new PrismaClient()
  const ids = {
    manager: `user_rc_manager_${token}`,
    admin: `user_rc_admin_${token}`,
    officer: `user_rc_officer_${token}`,
    foreign: `user_rc_foreign_${token}`,
  }

  function signIn(id: string, role: UserRole, tenantId = tenantA) {
    h.session = { user: { id, email: emailOf(id), name: null, role, tenantId, totpVerified: true } }
  }

  function post(body: Record<string, unknown>) {
    return POST(new NextRequest("http://localhost/api/settings/users", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-slug": slugA },
      body: JSON.stringify(body),
    }))
  }

  function patch(id: string, body: Record<string, unknown>, slug = slugA) {
    return PATCH(
      new NextRequest(`http://localhost/api/settings/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    )
  }

  const stored = (id: string) => db.user.findUniqueOrThrow({
    where: { id },
    select: { role: true, email: true, password: true, active: true, tenantId: true, tokenVersion: true },
  })

  beforeAll(async () => {
    await db.tenant.createMany({
      data: [
        { id: tenantA, slug: slugA, name: "Role Ceiling Integration Test A" },
        { id: tenantB, slug: slugB, name: "Role Ceiling Integration Test B" },
      ],
    })
    const user = (id: string, tenantId: string, role: UserRole) =>
      ({ id, tenantId, role, email: emailOf(id), name: "Synthetic Staff", password: "not-a-login-credential" })
    await db.user.createMany({
      data: [
        user(ids.manager, tenantA, "BRANCH_MANAGER"),
        user(ids.admin, tenantA, "ADMIN"),
        user(ids.officer, tenantA, "CREDIT_OFFICER"),
        user(ids.foreign, tenantB, "CREDIT_OFFICER"),
      ],
    })
  })

  afterAll(async () => {
    const tenants = { tenantId: { in: [tenantA, tenantB] } }
    await db.auditLog.deleteMany({ where: tenants })
    await db.user.deleteMany({ where: tenants })
    await db.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await db.$disconnect()
  })

  it("refuses a branch manager promoting a user to SUPER_ADMIN: the row is untouched and the attempt is in the trail", async () => {
    signIn(ids.manager, "BRANCH_MANAGER")
    const before = await stored(ids.officer)
    const res = await patch(ids.officer, { role: "SUPER_ADMIN" })

    expect(res.status).toBe(403)
    expect(await stored(ids.officer)).toEqual(before)
    const refusals = await db.auditLog.findMany({ where: { tenantId: tenantA, action: "USER_WRITE_REFUSED", entityId: ids.officer } })
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({
      userId: ids.manager,
      entity: "User",
      newValue: { refused: true, reason: "role_above_caller", httpStatus: 403, callerRole: "BRANCH_MANAGER", targetRole: "CREDIT_OFFICER", assignedRole: "SUPER_ADMIN" },
    })
  })

  it("refuses a branch manager taking over an admin (password, email, deactivation): the row is untouched", async () => {
    signIn(ids.manager, "BRANCH_MANAGER")
    const before = await stored(ids.admin)

    for (const body of [{ password: "synthetic-pass-2" }, { email: emailOf("takeover") }, { active: false }]) {
      expect((await patch(ids.admin, body)).status).toBe(403)
    }
    expect(await stored(ids.admin)).toEqual(before)
  })

  it("refuses creating a user above the caller's role, and creates no row", async () => {
    signIn(ids.admin, "ADMIN")
    const email = emailOf("escalated")
    const res = await post({ name: "Synthetic Staff", email, password: "synthetic-pass-1", role: "SUPER_ADMIN" })

    expect(res.status).toBe(403)
    expect(await db.user.findUnique({ where: { email } })).toBeNull()
  })

  it("rejects a role the database enum does not have with 400, not a 500", async () => {
    signIn(ids.admin, "ADMIN")
    const email = emailOf("unknown-role")
    const res = await post({ name: "Synthetic Staff", email, password: "synthetic-pass-1", role: "OWNER" })

    expect(res.status).toBe(400)
    expect(await db.user.findUnique({ where: { email } })).toBeNull()
  })

  it("cannot reach another tenant's user by id: 404, and that row is untouched", async () => {
    signIn(ids.admin, "ADMIN")
    const before = await stored(ids.foreign)

    for (const body of [{ role: "READONLY" }, { password: "synthetic-pass-2" }, { active: false }, { tenantId: tenantA }]) {
      expect((await patch(ids.foreign, body)).status).toBe(404)
    }
    expect(await stored(ids.foreign)).toEqual(before)
  })

  it("cannot act on another tenant by naming it in the request: 403, and that row is untouched", async () => {
    signIn(ids.admin, "ADMIN")
    const before = await stored(ids.foreign)

    expect((await patch(ids.foreign, { role: "READONLY" }, slugB)).status).toBe(403)
    expect(await stored(ids.foreign)).toEqual(before)
  })

  it("creates a permitted user in the caller's tenant, whatever tenant the body names", async () => {
    signIn(ids.admin, "ADMIN")
    const email = emailOf("created")
    const res = await post({ name: "Synthetic Staff", email, password: "synthetic-pass-1", role: "LOAN_ADMIN", tenantId: tenantB })

    expect(res.status).toBe(201)
    expect(await db.user.findUniqueOrThrow({ where: { email }, select: { tenantId: true, role: true } }))
      .toEqual({ tenantId: tenantA, role: "LOAN_ADMIN" })
  })

  it("applies a permitted role change and records the old and new role in the audit row", async () => {
    signIn(ids.admin, "ADMIN")
    const before = await stored(ids.officer)
    const res = await patch(ids.officer, { role: "LOAN_ADMIN" })

    expect(res.status).toBe(200)
    expect(await stored(ids.officer)).toEqual({ ...before, role: "LOAN_ADMIN", tokenVersion: before.tokenVersion + 1 })
    const updates = await db.auditLog.findMany({ where: { tenantId: tenantA, action: "USER_UPDATED", entityId: ids.officer } })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      userId: ids.admin,
      oldValue: { role: "CREDIT_OFFICER" },
      newValue: { changed: ["role"], role: "LOAN_ADMIN" },
    })
  })
})
