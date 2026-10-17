import { describe, expect, it, vi } from "vitest"
import { createFakeDb } from "./fake-db.test-helpers"
import { bootstrapTenant, TenantBootstrapRefusal } from "./bootstrap-tenant"
import { parseTenantConfig, type TenantBootstrapConfig } from "./tenant-config"
import { validFile } from "./tenant-config.test-helpers"

function config(over: Record<string, unknown> = {}): TenantBootstrapConfig {
  const r = parseTenantConfig({ ...validFile(), ...over })
  if (!r.ok) throw new Error(r.errors.join("; "))
  return r.config
}

const run = (f: ReturnType<typeof createFakeDb>, c: TenantBootstrapConfig, dryRun = false, seed = vi.fn(async () => {})) =>
  bootstrapTenant(f.db, c, { dryRun, operator: "ops@host", seedTemplates: seed })

const refusal = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    if (e instanceof TenantBootstrapRefusal) return e.code
    throw e
  }
  return "none"
}

describe("bootstrapTenant", () => {
  it("creates an ACTIVE tenant with its config, two audit rows, and seeds templates for the brand", async () => {
    const f = createFakeDb()
    const seed = vi.fn(async () => {})
    const r = await run(f, config(), false, seed)

    expect(r.status).toBe("created")
    expect(f.tables.tenants).toHaveLength(1)
    expect(f.tables.tenants[0]).toMatchObject({ slug: "staging-lender", name: "Staging Lender (Pty) Ltd", status: "ACTIVE" })
    expect(f.tables.tenantConfigs[0]).toMatchObject({ legalName: "Staging Lender (Pty) Ltd", brandName: "Staging Lender", ncrNumber: "NCRCP99999", featureLms: true, featureCrm: false })
    expect(f.tables.auditLogs.map((a) => a.action).sort()).toEqual(["LENDER_IDENTITY_UPDATED", "TENANT_CREATED"])
    expect(seed).toHaveBeenCalledWith(f.tables.tenants[0].id, "Staging Lender")
  })

  it("converts the DATE columns to Dates", async () => {
    const f = createFakeDb()
    const c = config()
    c.identity.ncrRegistrationDate = "2020-01-31"
    await run(f, c)
    expect(f.tables.tenantConfigs[0].ncrRegistrationDate).toEqual(new Date("2020-01-31T00:00:00.000Z"))
  })

  it("dry-run writes and seeds nothing", async () => {
    const f = createFakeDb()
    const seed = vi.fn(async () => {})
    const r = await run(f, config(), true, seed)
    expect(r.status).toBe("dry-run-create")
    expect(f.tables.tenants).toHaveLength(0)
    expect(seed).not.toHaveBeenCalled()
  })

  it("is idempotent: an identical rerun changes nothing, writes no audit row, but re-ensures templates", async () => {
    const f = createFakeDb()
    await run(f, config())
    const seed = vi.fn(async () => {})
    const r = await run(f, config(), false, seed)
    expect(r.status).toBe("unchanged")
    expect(f.tables.tenants).toHaveLength(1)
    expect(f.tables.auditLogs).toHaveLength(2)
    expect(seed).toHaveBeenCalledTimes(1)
  })

  it("refuses to rewrite an existing tenant whose config differs, naming the fields and not the values", async () => {
    const f = createFakeDb()
    await run(f, config())
    const changed = config()
    changed.identity.ncrNumber = "NCRCP11111"
    changed.colours.primaryColor = "#123456"
    const seed = vi.fn(async () => {})
    let err: unknown
    try {
      await run(f, changed, false, seed)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TenantBootstrapRefusal)
    expect((err as TenantBootstrapRefusal).code).toBe("TENANT_DIFFERS")
    expect((err as Error).message).toMatch(/ncrNumber/)
    expect((err as Error).message).toMatch(/primaryColor/)
    expect((err as Error).message).not.toContain("NCRCP11111")
    expect(f.tables.tenantConfigs[0].ncrNumber).toBe("NCRCP99999")
    expect(seed).not.toHaveBeenCalled()
  })

  // #147 review: a real lender is never provisioned onto a seeded demo tenant,
  // whose marker would let its Section 129 notices be simulated.
  it("refuses an existing tenant marked as a demo lender, even when the file matches it", async () => {
    const f = createFakeDb()
    await run(f, config())
    f.tables.tenantConfigs[0].isDemoLender = true
    const seed = vi.fn(async () => {})
    expect(await refusal(run(f, config(), false, seed))).toBe("DEMO_LENDER")
    expect(await refusal(run(f, config(), true, seed))).toBe("DEMO_LENDER")
    expect(seed).not.toHaveBeenCalled()
  })

  it("refuses an existing tenant that has no config row at all", async () => {
    const f = createFakeDb({ tenants: [{ id: "t1", slug: "staging-lender", name: "Staging Lender (Pty) Ltd", status: "ACTIVE", domain: null }] })
    expect(await refusal(run(f, config()))).toBe("TENANT_DIFFERS")
  })

  it("refuses a domain already used by another tenant", async () => {
    const f = createFakeDb({ tenants: [{ id: "t9", slug: "other", name: "Other", status: "ACTIVE", domain: "lender.example" }] })
    expect(await refusal(run(f, config({ domain: "lender.example" })))).toBe("DOMAIN_IN_USE")
    expect(f.tables.tenants).toHaveLength(1)
  })

  it("puts the tenant under the given operator and names the console user on the audit rows", async () => {
    const f = createFakeDb()
    await bootstrapTenant(f.db, config(), {
      dryRun: false, operator: "operator-console:admin@op.invalid", seedTemplates: vi.fn(async () => {}),
      operatorId: "op-7", actor: { userId: "u-op", email: "admin@op.invalid" },
    })
    expect(f.tables.tenants[0]).toMatchObject({ operatorId: "op-7" })
    expect(f.tables.auditLogs.map((a) => [a.userId, a.userEmail])).toEqual([["u-op", "admin@op.invalid"], ["u-op", "admin@op.invalid"]])
  })

  it("leaves the operator to the database default and the CLI as the actor when none is given", async () => {
    const f = createFakeDb()
    await run(f, config())
    expect(f.tables.tenants[0].operatorId).toBeUndefined()
    expect(f.tables.auditLogs.every((a) => a.userEmail === "lender:bootstrap-tenant" && a.userId === null)).toBe(true)
  })

  // PR #91 round 2: the CLI applies the same host rules as the console.
  it("refuses a domain this deployment already serves (lib/config/tenant-domain.ts)", async () => {
    vi.stubEnv("OPERATOR_APP_HOST", "console.platform.example")
    try {
      const f = createFakeDb()
      expect(await refusal(run(f, config({ domain: "console.platform.example" })))).toBe("DOMAIN_RESERVED")
      expect(f.tables.tenants).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses another lender's subdomain host as a domain, and a slug whose subdomain host is another lender's domain", async () => {
    const f = createFakeDb({ tenants: [{ id: "t9", slug: "acme", name: "Acme", status: "ACTIVE", domain: "staging-lender.lenders.example" }] })
    expect(await refusal(run(f, config({ domain: "acme.lenders.example" })))).toBe("DOMAIN_RESERVED")
    expect(await refusal(run(f, config()))).toBe("SLUG_HOST_TAKEN")
    expect(f.tables.tenants).toHaveLength(1)
  })

  it("rolls the tenant back when an audit row cannot be written", async () => {
    const f = createFakeDb()
    f.tx.auditLog.create = (async () => {
      throw new Error("audit down")
    }) as never
    await expect(run(f, config())).rejects.toThrow("audit down")
    expect(f.tables.tenants).toHaveLength(0)
    expect(f.tables.tenantConfigs).toHaveLength(0)
  })
})
