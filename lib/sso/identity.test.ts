import { beforeEach, describe, expect, it, vi } from "vitest"

const { users, audits, flags, tx } = vi.hoisted(() => {
type U = { id: string; email: string; role: string; tenantId: string | null; active: boolean; operatorId: string | null; name: string | null }
const users = new Map<string, U>()
const audits: Array<{ action: string; newValue: unknown }> = []
const flags = { createRace: false }

const tx = {
  user: {
    findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<U> }) => {
      const u = [...users.values()].find((x) => x.id === where.id)!
      Object.assign(u, data)
      return u
    }),
    create: vi.fn(async ({ data }: { data: Omit<U, "id" | "operatorId"> & { password: string } }) => {
      if (flags.createRace) {
        flags.createRace = false
        users.set(data.email, { id: "winner", email: data.email, role: "READONLY", tenantId: data.tenantId, active: true, operatorId: null, name: null })
        throw Object.assign(new Error("unique"), { code: "P2002" })
      }
      const u = { id: `new-${users.size}`, operatorId: null, ...data }
      users.set(data.email, u)
      return u
    }),
  },
  auditLog: { create: vi.fn(async ({ data }: { data: { action: string; newValue: unknown } }) => { audits.push(data) }) },
}
  return { users, audits, flags, tx }
})
type U = { id: string; email: string; role: string; tenantId: string | null; active: boolean; operatorId: string | null; name: string | null }
vi.mock("@/lib/prisma", () => ({ prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }))

import { resolveStaffUser, type IdpIdentity } from "./identity"
import type { LoadedConnection } from "./connection"

const conn = (over: Partial<LoadedConnection> = {}) => ({
  tenantId: "t1", allowedEmailDomains: [], groupRoleMap: { admins: "ADMIN", staff: "READONLY" },
  jitProvisioning: false, jitDefaultRole: null, ...over,
}) as LoadedConnection

const who = (over: Partial<IdpIdentity> = {}): IdpIdentity => ({ email: "Ann@Bank.Example.test", groups: [], mfaProven: false, ...over })
const seed = (u: Partial<U> = {}) => users.set("ann@bank.example.test", { id: "u1", email: "ann@bank.example.test", role: "CREDIT_OFFICER", tenantId: "t1", active: true, operatorId: null, name: "Ann", ...u })

beforeEach(() => { users.clear(); audits.length = 0; flags.createRace = false })

describe("resolveStaffUser: existing users", () => {
  it("matches by email, case-insensitively", async () => {
    seed()
    expect(await resolveStaffUser(who(), conn())).toMatchObject({ ok: true, userId: "u1", created: false })
  })

  it("refuses an unknown email when provisioning is off", async () => {
    expect(await resolveStaffUser(who(), conn())).toEqual({ ok: false, reason: "no_account" })
    expect(users.size).toBe(0)
  })

  it("refuses a user of another lender", async () => {
    seed({ tenantId: "t2" })
    expect(await resolveStaffUser(who(), conn())).toEqual({ ok: false, reason: "no_account" })
  })

  it("refuses an operator user", async () => {
    seed({ tenantId: null, operatorId: "op1", role: "OPERATOR_ADMIN" })
    expect(await resolveStaffUser(who(), conn())).toEqual({ ok: false, reason: "no_account" })
  })

  it("refuses an email the provider marks unverified", async () => {
    seed()
    expect(await resolveStaffUser(who({ emailVerified: false }), conn())).toEqual({ ok: false, reason: "email_unverified" })
  })

  it("refuses an email outside the allowed domains", async () => {
    seed()
    expect(await resolveStaffUser(who(), conn({ allowedEmailDomains: ["other.test"] }))).toEqual({ ok: false, reason: "domain_not_allowed" })
    expect((await resolveStaffUser(who(), conn({ allowedEmailDomains: ["bank.example.test"] }))).ok).toBe(true)
  })

  it("syncs the role to the highest mapped group and audits it", async () => {
    seed()
    const out = await resolveStaffUser(who({ groups: ["staff", "admins"] }), conn())
    expect(out).toMatchObject({ ok: true, roleChanged: { from: "CREDIT_OFFICER", to: "ADMIN" } })
    expect(users.get("ann@bank.example.test")!.role).toBe("ADMIN")
    expect(audits.map((a) => a.action)).toEqual(["SSO_ROLE_SYNCED"])
  })

  it("leaves the role alone when no group is mapped", async () => {
    seed()
    await resolveStaffUser(who({ groups: ["unmapped"] }), conn())
    expect(users.get("ann@bank.example.test")!.role).toBe("CREDIT_OFFICER")
    expect(audits).toEqual([])
  })

  it("never changes a SUPER_ADMIN's role", async () => {
    seed({ role: "SUPER_ADMIN" })
    const out = await resolveStaffUser(who({ groups: ["staff"] }), conn())
    expect(out).toMatchObject({ ok: true })
    expect(users.get("ann@bank.example.test")!.role).toBe("SUPER_ADMIN")
  })
})

describe("resolveStaffUser: just-in-time provisioning", () => {
  const jit = conn({ jitProvisioning: true, jitDefaultRole: "READONLY" })

  it("creates a user with the default role and audits it", async () => {
    const out = await resolveStaffUser(who({ name: "Ann Lee" }), jit)
    expect(out).toMatchObject({ ok: true, created: true })
    const created = users.get("ann@bank.example.test")!
    expect(created).toMatchObject({ role: "READONLY", tenantId: "t1", active: true, name: "Ann Lee" })
    expect(audits.map((a) => a.action)).toEqual(["SSO_USER_PROVISIONED"])
  })

  it("uses the mapped role over the default", async () => {
    await resolveStaffUser(who({ groups: ["admins"] }), jit)
    expect(users.get("ann@bank.example.test")!.role).toBe("ADMIN")
  })

  it("never creates a SUPER_ADMIN, even if the stored map or default says so", async () => {
    const hostile = conn({ jitProvisioning: true, jitDefaultRole: "SUPER_ADMIN" as never, groupRoleMap: { g: "SUPER_ADMIN" } as never })
    const out = await resolveStaffUser(who({ groups: ["g"] }), hostile)
    expect(out).toEqual({ ok: false, reason: "no_account" })
    expect(users.size).toBe(0)
  })

  it("still enforces the domain rule", async () => {
    expect(await resolveStaffUser(who(), conn({ jitProvisioning: true, jitDefaultRole: "READONLY", allowedEmailDomains: ["other.test"] })))
      .toEqual({ ok: false, reason: "domain_not_allowed" })
  })

  it("settles a creation race on the existing row", async () => {
    flags.createRace = true
    expect(await resolveStaffUser(who(), jit)).toMatchObject({ ok: true, userId: "winner" })
  })
})
