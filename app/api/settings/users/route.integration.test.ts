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
import { AsyncLocalStorage } from "node:async_hooks"
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

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  /** Runs once, right after the route's first read of the target. */
  afterTargetRead: null as null | (() => Promise<unknown>),
  /** Runs after every raw query a route's transaction makes (its row lock). */
  afterLock: null as null | (() => Promise<unknown>),
}))
// Per-request sessions, for requests that run concurrently.
const sessions = new AsyncLocalStorage<{ user: Record<string, unknown> }>()

// The session is the only seam mocked. requireApiRole, the write gate,
// withTenantContext (which binds the session's tenant to the request's) and
// the audit writer are the real ones, against the real database.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => sessions.getStore() ?? h.session }))
// The real client, with a hook after `user.findFirst` — the read the route's
// first role check is made on. A change injected there lands after that check
// and before the write: the window a concurrent promotion or demotion has.
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
  // And a hook after the transaction's lock query, to hold two writes' locks open at once.
  const $transaction = (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
    (prisma.$transaction as (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>)(async (tx) => fn(new Proxy(tx as object, {
      get: (target, key) => key !== "$queryRaw" ? Reflect.get(target, key) : async (...args: unknown[]) => {
        const rows = await (target as { $queryRaw: (...a: unknown[]) => Promise<unknown> }).$queryRaw(...args)
        await h.afterLock?.()
        return rows
      },
    })), options)
  return {
    prisma: new Proxy(prisma, {
      get: (target, key) => key === "user" ? user : key === "$transaction" ? $transaction : Reflect.get(target, key),
    }),
  }
})

import { POST } from "./route"
import { DELETE, PATCH } from "./[id]/route"
import { refuseLockedStaffUserWrite, type StaffUser } from "@/lib/auth-guards"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("staff-user role ceiling and tenant boundary (real database)", () => {
  const db = new PrismaClient()
  const ids = {
    manager: `user_rc_manager_${token}`,
    admin: `user_rc_admin_${token}`,
    officer: `user_rc_officer_${token}`,
    foreign: `user_rc_foreign_${token}`,
    root: `user_rc_root_${token}`,
    superA: `user_rc_super_a_${token}`,
    superB: `user_rc_super_b_${token}`,
    peerA: `user_rc_peer_a_${token}`,
    peerB: `user_rc_peer_b_${token}`,
    shared: `user_rc_shared_${token}`,
    held: `user_rc_held_${token}`,
    heldVictim: `user_rc_held_victim_${token}`,
    raceAdmin: `user_rc_race_admin_${token}`,
    raceTarget: `user_rc_race_target_${token}`,
    raceOfficer: `user_rc_race_officer_${token}`,
    victim: `user_rc_victim_${token}`,
  }

  function signIn(id: string, role: UserRole, tenantId = tenantA) {
    h.session = session(id, role, tenantId)
  }

  function session(id: string, role: UserRole, tenantId = tenantA) {
    return { user: { id, email: emailOf(id), name: null, role, tenantId, totpVerified: true, tokenVersion: 0 } }
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
        user(ids.root, tenantA, "SUPER_ADMIN"),
        user(ids.peerA, tenantA, "ADMIN"),
        user(ids.peerB, tenantA, "ADMIN"),
        user(ids.shared, tenantA, "CREDIT_OFFICER"),
        user(ids.superA, tenantA, "SUPER_ADMIN"),
        user(ids.superB, tenantA, "SUPER_ADMIN"),
        user(ids.held, tenantA, "CREDIT_OFFICER"),
        user(ids.heldVictim, tenantA, "READONLY"),
        user(ids.raceAdmin, tenantA, "ADMIN"),
        user(ids.raceTarget, tenantA, "LOAN_ADMIN"),
        user(ids.raceOfficer, tenantA, "CREDIT_OFFICER"),
        user(ids.victim, tenantA, "READONLY"),
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

  // Both requests pass the email probe (it runs before the password hash) and
  // meet the unique index in their transactions: the loser must be a 409.
  it("answers 409, never 500, for two concurrent creates of the same email, and creates one user", async () => {
    const email = emailOf("concurrent")
    const create = () => sessions.run(session(ids.admin, "ADMIN"), () =>
      post({ name: "Synthetic Staff", email, password: "synthetic-pass-1", role: "LOAN_ADMIN" }))
    const statuses = (await Promise.all([create(), create()])).map((res) => res.status).sort()

    expect(statuses).toEqual([201, 409])
    expect(await db.user.count({ where: { email } })).toBe(1)
    expect(await db.auditLog.count({ where: { tenantId: tenantA, action: "USER_CREATED", newValue: { path: ["email"], equals: email } } })).toBe(1)
  })

  it("treats an email differing only in case as a duplicate", async () => {
    signIn(ids.admin, "ADMIN")
    const email = emailOf("casing")
    expect((await post({ name: "Synthetic Staff", email, password: "synthetic-pass-1", role: "LOAN_ADMIN" })).status).toBe(201)
    expect((await post({ name: "Synthetic Staff", email: email.toUpperCase(), password: "synthetic-pass-1", role: "LOAN_ADMIN" })).status).toBe(409)
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

  // The write re-checks on the rows its transaction locks. Without that, each
  // of these lands: the first check passed on roles that changed before the
  // write.
  describe("a role change between the check and the write", () => {
    const setRole = (id: string, role: UserRole) => () => db.user.update({ where: { id }, data: { role } })
    const del = (id: string) => DELETE(
      new NextRequest(`http://localhost/api/settings/users/${id}`, { method: "DELETE", headers: { "x-tenant-slug": slugA } }),
      { params: Promise.resolve({ id }) },
    )

    it("refuses an admin's password reset on a user promoted to SUPER_ADMIN meanwhile, and audits the refusal", async () => {
      signIn(ids.raceAdmin, "ADMIN")
      const before = await stored(ids.raceTarget)
      h.afterTargetRead = setRole(ids.raceTarget, "SUPER_ADMIN")
      const res = await patch(ids.raceTarget, { password: "synthetic-pass-3", email: emailOf("race-takeover") })

      expect(res.status).toBe(403)
      expect(await stored(ids.raceTarget)).toEqual({ ...before, role: "SUPER_ADMIN" })
      const refusals = await db.auditLog.findMany({ where: { tenantId: tenantA, action: "USER_WRITE_REFUSED", entityId: ids.raceTarget } })
      expect(refusals).toHaveLength(1)
      expect(refusals[0]!.newValue).toMatchObject({ reason: "target_outranks_caller", callerRole: "ADMIN", targetRole: "SUPER_ADMIN" })
    })

    it("refuses an edit by an admin demoted meanwhile", async () => {
      signIn(ids.raceAdmin, "ADMIN")
      const before = await stored(ids.raceOfficer)
      h.afterTargetRead = setRole(ids.raceAdmin, "READONLY")
      const res = await patch(ids.raceOfficer, { role: "ADMIN" })

      expect(res.status).toBe(403)
      expect(await stored(ids.raceOfficer)).toEqual(before)
      await setRole(ids.raceAdmin, "ADMIN")()
    })

    // A password reset, deactivation or role change of the caller bumps its
    // tokenVersion: the session that started the request is no longer valid.
    it("refuses an edit by an admin whose session was invalidated meanwhile", async () => {
      signIn(ids.raceAdmin, "ADMIN")
      const before = await stored(ids.raceOfficer)
      h.afterTargetRead = () => db.user.update({ where: { id: ids.raceAdmin }, data: { tokenVersion: { increment: 1 } } })
      const res = await patch(ids.raceOfficer, { password: "synthetic-pass-4" })

      expect(res.status).toBe(403)
      expect(await stored(ids.raceOfficer)).toEqual(before)
      await db.user.update({ where: { id: ids.raceAdmin }, data: { tokenVersion: 0 } })
    })

    it("refuses a delete by a SUPER_ADMIN demoted meanwhile, and the user still exists", async () => {
      signIn(ids.root, "SUPER_ADMIN")
      h.afterTargetRead = setRole(ids.root, "ADMIN")
      const res = await del(ids.victim)

      expect(res.status).toBe(403)
      expect(await db.user.findUnique({ where: { id: ids.victim }, select: { id: true, active: true } }))
        .toEqual({ id: ids.victim, active: true })
      await setRole(ids.root, "SUPER_ADMIN")()
    })

    it("records the role the row had when it was locked as the old role", async () => {
      signIn(ids.raceAdmin, "ADMIN")
      h.afterTargetRead = setRole(ids.raceOfficer, "LOAN_ADMIN")
      const res = await patch(ids.raceOfficer, { role: "BRANCH_MANAGER" })

      expect(res.status).toBe(200)
      const updates = await db.auditLog.findMany({ where: { tenantId: tenantA, action: "USER_UPDATED", entityId: ids.raceOfficer } })
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({ oldValue: { role: "LOAN_ADMIN" }, newValue: { changed: ["role"], role: "BRANCH_MANAGER" } })
    })

    // The re-check's rows stay locked until the write commits: a role change
    // from another connection cannot slip in between the re-check and the write.
    it("holds the caller's and the target's rows against a concurrent role change until the transaction ends", async () => {
      const other = new PrismaClient()
      const caller: StaffUser = { id: ids.raceAdmin, email: emailOf(ids.raceAdmin), name: null, role: "ADMIN", tenantId: tenantA, totpVerified: true, tokenVersion: 0 }
      const tryPromote = (id: string) => other.$transaction([
        other.$executeRaw`SET LOCAL lock_timeout = '200ms'`,
        other.user.update({ where: { id }, data: { role: "SUPER_ADMIN" } }),
      ])
      try {
        await db.$transaction(async (tx) => {
          // The routes pass the app's extended client; this vanilla one exposes
          // the same $queryRaw and auditLog at runtime.
          const locked = await refuseLockedStaffUserWrite(tx as never, caller, { tenantId: tenantA, targetId: ids.raceOfficer, assignedRole: undefined })
          expect(locked.refused).toBeNull()
          await expect(tryPromote(ids.raceOfficer)).rejects.toThrow(/lock/i)
          await expect(tryPromote(ids.raceAdmin)).rejects.toThrow(/lock/i)
        })
        expect((await stored(ids.raceOfficer)).role).not.toBe("SUPER_ADMIN")
      } finally {
        await other.$disconnect()
      }
    })

    // Every path locks the caller's and target's rows in one statement, in id
    // order. Two admins editing the same user at once therefore queue rather
    // than each holding their own row and waiting for the other's. The barrier
    // holds the first lock open until the second write has tried for its own.
    // (Peers cannot edit each other, so the contended row is a junior's.)
    it("lets two admins edit the same user at the same time without a deadlock", async () => {
      let arrived = 0
      let release!: () => void
      const both = new Promise<void>((resolve) => { release = resolve })
      h.afterLock = async () => {
        if (++arrived === 2) release()
        await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 500))])
      }
      try {
        const [a, b] = await Promise.all([
          sessions.run(session(ids.peerA, "ADMIN"), () => patch(ids.shared, { name: "Edited By A" })),
          sessions.run(session(ids.peerB, "ADMIN"), () => patch(ids.shared, { name: "Edited By B" })),
        ])
        expect([a.status, b.status]).toEqual([200, 200])
      } finally {
        h.afterLock = null
      }
      expect(["Edited By A", "Edited By B"]).toContain((await db.user.findUniqueOrThrow({ where: { id: ids.shared } })).name)
    })

    it("refuses an admin editing a peer, and a SUPER_ADMIN editing or removing another SUPER_ADMIN, leaving the rows untouched", async () => {
      const before = { peer: await stored(ids.peerB), root: await stored(ids.superB) }
      signIn(ids.peerA, "ADMIN")
      expect((await patch(ids.peerB, { password: "synthetic-pass-9", role: "READONLY" })).status).toBe(403)
      signIn(ids.superA, "SUPER_ADMIN")
      expect((await patch(ids.superB, { role: "ADMIN" })).status).toBe(403)
      expect((await del(ids.superB)).status).toBe(403)

      expect(await stored(ids.peerB)).toEqual(before.peer)
      expect(await stored(ids.superB)).toEqual(before.root)
      expect(await db.auditLog.count({ where: { tenantId: tenantA, action: "USER_WRITE_REFUSED", userId: { in: [ids.peerA, ids.superA] }, newValue: { path: ["reason"], equals: "target_same_rank" } } })).toBe(3)
    })

    it("lets an admin still edit their own profile fields", async () => {
      signIn(ids.peerA, "ADMIN")
      const res = await patch(ids.peerA, { name: "Own Name" })
      expect(res.status).toBe(200)
      expect((await db.user.findUniqueOrThrow({ where: { id: ids.peerA } })).name).toBe("Own Name")
    })

    it("still lets a SUPER_ADMIN delete a user with no history", async () => {
      signIn(ids.root, "SUPER_ADMIN")
      const res = await del(ids.victim)

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ mode: "deleted" })
      expect(await db.user.findUnique({ where: { id: ids.victim } })).toBeNull()
      expect(await db.auditLog.count({ where: { tenantId: tenantA, action: "USER_DELETED", entityId: ids.victim, userId: ids.root } })).toBe(1)
    })
  })

  // An open transaction elsewhere holding FOR KEY SHARE on the target (an FK
  // insert naming the user does) blocks a key-changing update or a delete of
  // it. The write must give up quickly, not sit on the caller's locked row
  // until Prisma's 5 s transaction timeout, and must leave nothing behind.
  describe("a target row held by another transaction", () => {
    async function whileHeld<T>(id: string, run: () => Promise<T>): Promise<T> {
      const other = new PrismaClient()
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let locked!: () => void
      const isLocked = new Promise<void>((resolve) => { locked = resolve })
      const holder = other.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR KEY SHARE`
        locked()
        await released
      }, { timeout: 15_000 })
      try {
        await isLocked
        return await run()
      } finally {
        release()
        await holder
        await other.$disconnect()
      }
    }

    it("answers an email change with 409 within about 3 s, and changes and audits nothing", async () => {
      signIn(ids.raceAdmin, "ADMIN")
      const before = await stored(ids.held)
      const started = Date.now()
      const res = await whileHeld(ids.held, () => patch(ids.held, { email: emailOf("held-new") }))

      expect(Date.now() - started).toBeLessThan(3_500)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: "This user is being changed elsewhere. Try again." })
      expect(await stored(ids.held)).toEqual(before)
      expect(await db.auditLog.count({ where: { tenantId: tenantA, entityId: ids.held } })).toBe(0)
    })

    it("answers a delete with 409 within about 3 s, and the user still exists", async () => {
      signIn(ids.root, "SUPER_ADMIN")
      const started = Date.now()
      const res = await whileHeld(ids.heldVictim, () => DELETE(
        new NextRequest(`http://localhost/api/settings/users/${ids.heldVictim}`, { method: "DELETE", headers: { "x-tenant-slug": slugA } }),
        { params: Promise.resolve({ id: ids.heldVictim }) },
      ))

      expect(Date.now() - started).toBeLessThan(3_500)
      expect(res.status).toBe(409)
      expect(await db.user.findUnique({ where: { id: ids.heldVictim }, select: { active: true } })).toEqual({ active: true })
      expect(await db.auditLog.count({ where: { tenantId: tenantA, entityId: ids.heldVictim } })).toBe(0)
    })

    // The caller's own row is free again at once: their sign-in bookkeeping
    // (lastLoginAt, the TOTP counter) is not left waiting on the refused write.
    it("releases the caller's row when it gives up", async () => {
      signIn(ids.raceAdmin, "ADMIN")
      await whileHeld(ids.held, () => patch(ids.held, { email: emailOf("held-newer") }))
      const started = Date.now()
      await db.user.update({ where: { id: ids.raceAdmin }, data: { lastLoginAt: new Date() } })
      expect(Date.now() - started).toBeLessThan(1_000)
    })
  })
})
