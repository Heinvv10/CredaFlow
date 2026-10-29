import { beforeEach, describe, expect, it, vi } from "vitest"

const { users, links, audits, flags, tx } = vi.hoisted(() => {
  type U = { id: string; email: string; role: string; tenantId: string | null; active: boolean; operatorId: string | null; name: string | null }
  type L = { tenantId: string; userId: string; subject: string }
  const users = new Map<string, U>()
  const links: L[] = []
  const audits: Array<{ action: string; newValue: unknown }> = []
  const flags = { createRace: false }
  const byId = (id: string) => [...users.values()].find((x) => x.id === id) ?? null
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => (where.email ? users.get(where.email) ?? null : byId(where.id as string))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<U> }) => Object.assign(byId(where.id)!, data)),
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
    ssoIdentity: {
      findFirst: vi.fn(async ({ where }: { where: Partial<L> }) =>
        links.find((l) => Object.entries(where).every(([k, v]) => l[k as keyof L] === v)) ?? null),
      create: vi.fn(async ({ data }: { data: L }) => {
        if (links.some((l) => l.tenantId === data.tenantId && (l.subject === data.subject || l.userId === data.userId))) {
          throw Object.assign(new Error("unique"), { code: "P2002" })
        }
        links.push(data)
        return data
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: { action: string; newValue: unknown } }) => { audits.push(data) }) },
  }
  return { users, links, audits, flags, tx }
})
type U = { id: string; email: string; role: string; tenantId: string | null; active: boolean; operatorId: string | null; name: string | null }
vi.mock("@/lib/prisma", () => ({ prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }))

import { resolveStaffUser, type IdpIdentity } from "./identity"
import type { LoadedConnection } from "./connection"

const conn = (over: Partial<LoadedConnection> = {}) => ({
  tenantId: "t1", allowedEmailDomains: [], groupRoleMap: { admins: "ADMIN", staff: "READONLY" },
  jitProvisioning: false, jitDefaultRole: null, allowUnverifiedEmail: false, ...over,
}) as LoadedConnection

const who = (over: Partial<IdpIdentity> = {}): IdpIdentity => ({
  subject: "https://idp.example.test|sub-ann", email: "Ann@Bank.Example.test", emailVerified: true, groups: [], mfaProven: false, ...over,
})
const seed = (u: Partial<U> = {}) => users.set("ann@bank.example.test", { id: "u1", email: "ann@bank.example.test", role: "CREDIT_OFFICER", tenantId: "t1", active: true, operatorId: null, name: "Ann", ...u })

beforeEach(() => { users.clear(); links.length = 0; audits.length = 0; flags.createRace = false })

describe("resolveStaffUser: email must be verified", () => {
  it("refuses an email the provider marks unverified", async () => {
    seed()
    expect(await resolveStaffUser(who({ emailVerified: false }), conn())).toEqual({ ok: false, reason: "email_unverified" })
    expect(links).toHaveLength(0)
  })

  it("refuses an identity that does not say (a missing claim is not a yes)", async () => {
    seed()
    expect(await resolveStaffUser(who({ emailVerified: undefined }), conn())).toEqual({ ok: false, reason: "email_unverified" })
    expect(links).toHaveLength(0)
  })

  it("accepts an unverified email only when the lender opted in", async () => {
    seed()
    expect((await resolveStaffUser(who({ emailVerified: undefined }), conn({ allowUnverifiedEmail: true }))).ok).toBe(true)
  })

  it("does not provision from an unverified email", async () => {
    const jit = conn({ jitProvisioning: true, jitDefaultRole: "READONLY" })
    expect(await resolveStaffUser(who({ emailVerified: undefined }), jit)).toEqual({ ok: false, reason: "email_unverified" })
    expect(users.size).toBe(0)
  })
})

describe("resolveStaffUser: subject binding", () => {
  it("links the stable subject on the first sign-in", async () => {
    seed()
    expect(await resolveStaffUser(who(), conn())).toMatchObject({ ok: true, userId: "u1" })
    expect(links).toEqual([{ tenantId: "t1", userId: "u1", subject: "https://idp.example.test|sub-ann" }])
  })

  it("afterwards matches on the subject, not the email", async () => {
    seed()
    await resolveStaffUser(who(), conn())
    // The directory re-uses nothing: same subject, a changed email still reaches the same account.
    expect(await resolveStaffUser(who({ email: "ann.new@bank.example.test" }), conn())).toMatchObject({ ok: true, userId: "u1" })
  })

  it("refuses another subject presenting the linked user's email (account takeover)", async () => {
    seed()
    await resolveStaffUser(who(), conn())
    expect(await resolveStaffUser(who({ subject: "https://idp.example.test|sub-attacker" }), conn())).toEqual({ ok: false, reason: "subject_mismatch" })
    expect(links).toHaveLength(1)
  })

  it("never lets a linked subject reach a different user through a different email", async () => {
    seed()
    users.set("bob@bank.example.test", { id: "u2", email: "bob@bank.example.test", role: "ADMIN", tenantId: "t1", active: true, operatorId: null, name: "Bob" })
    await resolveStaffUser(who(), conn())
    const out = await resolveStaffUser(who({ email: "bob@bank.example.test" }), conn())
    expect(out).toMatchObject({ ok: true, userId: "u1" })
  })

  it("keeps a link from another lender out of this one", async () => {
    seed()
    links.push({ tenantId: "t2", userId: "u9", subject: "https://idp.example.test|sub-ann" })
    expect(await resolveStaffUser(who(), conn())).toMatchObject({ ok: true, userId: "u1" })
  })

  it("refuses a subject linked to a user who is now another lender's or an operator's", async () => {
    seed({ tenantId: "t2" })
    links.push({ tenantId: "t1", userId: "u1", subject: "https://idp.example.test|sub-ann" })
    expect(await resolveStaffUser(who(), conn())).toEqual({ ok: false, reason: "no_account" })
  })
})

describe("resolveStaffUser: Super Admin does not sign in through the provider", () => {
  it("refuses a SUPER_ADMIN by email and links nothing", async () => {
    seed({ role: "SUPER_ADMIN" })
    expect(await resolveStaffUser(who(), conn())).toEqual({ ok: false, reason: "super_admin_password_only" })
    expect(links).toHaveLength(0)
  })

  it("refuses a SUPER_ADMIN even by a previously linked subject", async () => {
    seed({ role: "SUPER_ADMIN" })
    links.push({ tenantId: "t1", userId: "u1", subject: "https://idp.example.test|sub-ann" })
    expect(await resolveStaffUser(who(), conn())).toEqual({ ok: false, reason: "super_admin_password_only" })
  })

  it("never changes a SUPER_ADMIN's role", async () => {
    seed({ role: "SUPER_ADMIN" })
    await resolveStaffUser(who({ groups: ["staff"] }), conn())
    expect(users.get("ann@bank.example.test")!.role).toBe("SUPER_ADMIN")
  })
})

describe("resolveStaffUser: existing users", () => {
  it("matches by email, case-insensitively, the first time", async () => {
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
})

describe("resolveStaffUser: just-in-time provisioning", () => {
  const jit = conn({ jitProvisioning: true, jitDefaultRole: "READONLY" })

  it("creates a user with the default role, links the subject and audits it", async () => {
    const out = await resolveStaffUser(who({ name: "Ann Lee" }), jit)
    expect(out).toMatchObject({ ok: true, created: true })
    expect(users.get("ann@bank.example.test")).toMatchObject({ role: "READONLY", tenantId: "t1", active: true, name: "Ann Lee" })
    expect(links).toHaveLength(1)
    expect(audits.map((a) => a.action)).toEqual(["SSO_USER_PROVISIONED"])
  })

  it("uses the mapped role over the default", async () => {
    await resolveStaffUser(who({ groups: ["admins"] }), jit)
    expect(users.get("ann@bank.example.test")!.role).toBe("ADMIN")
  })

  it("never creates a SUPER_ADMIN, even if the stored map or default says so", async () => {
    const hostile = conn({ jitProvisioning: true, jitDefaultRole: "SUPER_ADMIN" as never, groupRoleMap: { g: "SUPER_ADMIN" } as never })
    expect(await resolveStaffUser(who({ groups: ["g"] }), hostile)).toEqual({ ok: false, reason: "no_account" })
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
