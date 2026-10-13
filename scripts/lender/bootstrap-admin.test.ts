import bcrypt from "bcryptjs"
import { describe, expect, it } from "vitest"
import { generateTotpCode, verifyTotpCode } from "@/lib/totp"
import { createFakeDb } from "./fake-db.test-helpers"
import { bootstrapSuperAdmin, BootstrapRefusal } from "./bootstrap-admin"

const OPERATOR = "ops@host"
const EMAIL = "owner@staging-lender.example"

function lender() {
  const f = createFakeDb({
    tenants: [{ id: "t1", slug: "staging", name: "Staging Lender", status: "ACTIVE" }],
    tenantConfigs: [{ id: "c1", tenantId: "t1", brandName: "Staging Brand" }],
  })
  return f
}

const bootstrap = (f: ReturnType<typeof lender>, over: Partial<Parameters<typeof bootstrapSuperAdmin>[1]> = {}) =>
  bootstrapSuperAdmin(f.db, { tenantSlug: "staging", email: EMAIL, mode: "bootstrap", dryRun: false, operator: OPERATOR, ...over })

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof BootstrapRefusal) return e.code
    throw e
  }
  return "none"
}

describe("bootstrapSuperAdmin: first admin", () => {
  it("creates one SUPER_ADMIN with a working password, an enrolled TOTP secret and one audit row", async () => {
    const f = lender()
    const r = await bootstrap(f)
    if (r.kind !== "created") throw new Error(`unexpected ${r.kind}`)

    expect(f.tables.users).toHaveLength(1)
    const user = f.tables.users[0]
    expect(user).toMatchObject({ email: EMAIL, role: "SUPER_ADMIN", tenantId: "t1", active: true, totpEnabled: true })
    expect(await bcrypt.compare(r.password, user.password as string)).toBe(true)
    expect(r.password.length).toBeGreaterThanOrEqual(24)
    expect(user.totpSecret).toBe(r.totpSecret)
    expect(verifyTotpCode(generateTotpCode(r.totpSecret), r.totpSecret)).not.toBeNull()
    expect(r.otpauthUri).toContain("Staging%20Brand")

    expect(f.tables.auditLogs).toHaveLength(1)
    expect(f.tables.auditLogs[0]).toMatchObject({ tenantId: "t1", action: "SUPER_ADMIN_BOOTSTRAPPED", entity: "User", entityId: user.id })
  })

  it("never writes the password, its hash or the TOTP secret into the audit row", async () => {
    const f = lender()
    const r = await bootstrap(f)
    if (r.kind !== "created") throw new Error("unexpected")
    const audit = JSON.stringify(f.tables.auditLogs)
    expect(audit).not.toContain(r.password)
    expect(audit).not.toContain(r.totpSecret)
    expect(audit).not.toContain(f.tables.users[0].password as string)
    expect(audit).toContain(OPERATOR)
  })

  it("normalises the email to lower case", async () => {
    const f = lender()
    await bootstrap(f, { email: "  Owner@Staging-Lender.EXAMPLE " })
    expect(f.tables.users[0].email).toBe(EMAIL)
  })

  it("takes the tenant row lock before it counts SUPER_ADMINs", async () => {
    const f = lender()
    await bootstrap(f)
    expect(f.calls).toEqual(["lock"])
  })

  it("dry-run reports what it would do and writes nothing", async () => {
    const f = lender()
    const r = await bootstrap(f, { dryRun: true })
    expect(r).toEqual({ kind: "dry-run", action: "create", tenantSlug: "staging", email: EMAIL })
    expect(f.tables.users).toHaveLength(0)
    expect(f.tables.auditLogs).toHaveLength(0)
  })
})

describe("bootstrapSuperAdmin: refusals", () => {
  it("refuses when the tenant already has a SUPER_ADMIN, even an inactive one, and writes nothing", async () => {
    const f = lender()
    f.tables.users.push({ id: "u0", email: "old@staging-lender.example", role: "SUPER_ADMIN", tenantId: "t1", active: false })
    expect(await refusal(bootstrap(f))).toBe("SUPER_ADMIN_EXISTS")
    expect(f.tables.users).toHaveLength(1)
    expect(f.tables.auditLogs).toHaveLength(0)
  })

  it("is one-shot: a second run refuses", async () => {
    const f = lender()
    await bootstrap(f)
    expect(await refusal(bootstrap(f, { email: "second@staging-lender.example" }))).toBe("SUPER_ADMIN_EXISTS")
    expect(f.tables.users).toHaveLength(1)
  })

  it("only counts SUPER_ADMINs of THIS tenant", async () => {
    const f = lender()
    f.tables.tenants.push({ id: "t2", slug: "other", name: "Other", status: "ACTIVE" })
    f.tables.users.push({ id: "u9", email: "x@other.example", role: "SUPER_ADMIN", tenantId: "t2", active: true })
    expect(await refusal(bootstrap(f))).toBe("none")
  })

  it("does not count lower roles as a SUPER_ADMIN", async () => {
    const f = lender()
    f.tables.users.push({ id: "u1", email: "a@staging-lender.example", role: "ADMIN", tenantId: "t1", active: true })
    expect(await refusal(bootstrap(f))).toBe("none")
  })

  it("refuses an unknown tenant", async () => {
    expect(await refusal(bootstrap(lender(), { tenantSlug: "nope" }))).toBe("TENANT_NOT_FOUND")
  })

  it("refuses an email that already belongs to a user (any tenant, any role)", async () => {
    const f = lender()
    f.tables.users.push({ id: "u1", email: EMAIL, role: "ADMIN", tenantId: "t1", active: true })
    expect(await refusal(bootstrap(f))).toBe("EMAIL_IN_USE")
    expect(f.tables.users[0].role).toBe("ADMIN")
  })

  it("refuses an invalid email", async () => {
    expect(await refusal(bootstrap(lender(), { email: "not-an-email" }))).toBe("INVALID_EMAIL")
  })

  it("rolls the user back when the audit row cannot be written", async () => {
    const f = lender()
    f.tx.auditLog.create = (async () => {
      throw new Error("audit down")
    }) as never
    await expect(bootstrap(f)).rejects.toThrow("audit down")
    expect(f.tables.users).toHaveLength(0)
  })
})

describe("bootstrapSuperAdmin: break-glass", () => {
  const locked = () => {
    const f = lender()
    f.tables.users.push({
      id: "u1", email: EMAIL, role: "SUPER_ADMIN", tenantId: "t1", active: false, password: "old-hash",
      totpEnabled: true, totpSecret: "OLDSECRET", lastTotpCounter: 99, resetToken: "tok", tokenVersion: 3,
    })
    return f
  }

  it("resets password and TOTP, reactivates (with --reactivate), invalidates sessions and writes one audit row", async () => {
    const f = locked()
    const r = await bootstrap(f, { mode: "break-glass", reactivate: true })
    if (r.kind !== "reset") throw new Error(`unexpected ${r.kind}`)
    expect(r.reactivated).toBe(true)
    const user = f.tables.users[0]
    expect(await bcrypt.compare(r.password, user.password as string)).toBe(true)
    expect(user).toMatchObject({ active: true, totpEnabled: true, totpSecret: r.totpSecret, lastTotpCounter: null, resetToken: null, tokenVersion: 4 })
    expect(r.totpSecret).not.toBe("OLDSECRET")
    expect(f.tables.auditLogs).toHaveLength(1)
    expect(f.tables.auditLogs[0]).toMatchObject({ action: "SUPER_ADMIN_BREAK_GLASS_RESET", entityId: "u1", oldValue: { active: false }, newValue: { reactivated: true } })
    const audit = JSON.stringify(f.tables.auditLogs)
    expect(audit).not.toContain(r.password)
    expect(audit).not.toContain(r.totpSecret)
  })

  it("refuses to switch a DEACTIVATED SUPER_ADMIN back on without --reactivate, even as a dry run, and writes nothing", async () => {
    for (const dryRun of [false, true]) {
      const f = locked()
      expect(await refusal(bootstrap(f, { mode: "break-glass", dryRun }))).toBe("REACTIVATE_REQUIRED")
      expect(f.tables.users[0]).toMatchObject({ password: "old-hash", active: false, tokenVersion: 3 })
      expect(f.tables.auditLogs).toHaveLength(0)
    }
  })

  it("needs no --reactivate for an active SUPER_ADMIN and reports it was not reactivated", async () => {
    const f = locked()
    f.tables.users[0].active = true
    const r = await bootstrap(f, { mode: "break-glass" })
    if (r.kind !== "reset") throw new Error("unexpected")
    expect(r.reactivated).toBe(false)
    expect(f.tables.auditLogs[0]).toMatchObject({ newValue: { reactivated: false } })
  })

  it("refuses a user who is not a SUPER_ADMIN of the tenant", async () => {
    const f = lender()
    f.tables.users.push({ id: "u1", email: EMAIL, role: "ADMIN", tenantId: "t1", active: true, password: "h" })
    expect(await refusal(bootstrap(f, { mode: "break-glass" }))).toBe("NO_SUCH_SUPER_ADMIN")
    expect(f.tables.users[0].password).toBe("h")
  })

  it("refuses a SUPER_ADMIN of another tenant", async () => {
    const f = locked()
    f.tables.users[0].tenantId = "t2"
    expect(await refusal(bootstrap(f, { mode: "break-glass" }))).toBe("NO_SUCH_SUPER_ADMIN")
  })

  it("never creates a user: with no SUPER_ADMIN at all it refuses", async () => {
    const f = lender()
    expect(await refusal(bootstrap(f, { mode: "break-glass" }))).toBe("NO_SUCH_SUPER_ADMIN")
    expect(f.tables.users).toHaveLength(0)
  })

  it("dry-run changes nothing", async () => {
    const f = locked()
    const r = await bootstrap(f, { mode: "break-glass", dryRun: true, reactivate: true })
    expect(r.kind).toBe("dry-run")
    expect(f.tables.users[0]).toMatchObject({ password: "old-hash", active: false })
    expect(f.tables.auditLogs).toHaveLength(0)
  })
})
