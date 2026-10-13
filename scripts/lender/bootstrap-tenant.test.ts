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

  it("refuses an existing tenant that has no config row at all", async () => {
    const f = createFakeDb({ tenants: [{ id: "t1", slug: "staging-lender", name: "Staging Lender (Pty) Ltd", status: "ACTIVE", domain: null }] })
    expect(await refusal(run(f, config()))).toBe("TENANT_DIFFERS")
  })

  it("refuses a domain already used by another tenant", async () => {
    const f = createFakeDb({ tenants: [{ id: "t9", slug: "other", name: "Other", status: "ACTIVE", domain: "lender.example" }] })
    expect(await refusal(run(f, config({ domain: "lender.example" })))).toBe("DOMAIN_IN_USE")
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
