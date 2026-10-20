import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The asset-finance switch and payout threshold: ADMIN only, audited per
// change, the legal-wording gate never written. Session, Prisma and the cache
// are stubbed; the route, its parser and the role map are real.
const m = vi.hoisted(() => ({
  session: { role: "ADMIN" as string },
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  executeRaw: vi.fn(),
  logAuditStrict: vi.fn(),
  revalidateTag: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("next/cache", () => ({ revalidateTag: m.revalidateTag }))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "admin-1", email: "admin@lender.test", role: m.session.role, tenantId: "tenant-1" } })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: m.findUnique },
    $transaction: (fn: (tx: unknown) => unknown) => fn({
      $executeRaw: m.executeRaw,
      tenantConfig: { findUnique: m.findUnique, update: m.update, create: m.create },
    }),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))

import { GET, PATCH } from "./route"

const current = {
  featureAssetFinance: false, assetPayoutDualApprovalCents: 100_000_000, assetFinanceLegalWordingApproved: false,
  featureDealerPortal: false, dealerCommissionClawbackMonths: 0, isDemoLender: false, telematicsPositionRetentionDays: 90,
}
const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/settings/asset-finance", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  m.session.role = "ADMIN"
  m.findUnique.mockResolvedValue(current)
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data }))
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...current, ...data }))
})

describe("/api/settings/asset-finance", () => {
  it.each(["LOAN_ADMIN", "CREDIT_OFFICER", "READONLY"])("refuses %s 403 and writes nothing", async (role) => {
    m.session.role = role
    expect((await patch({ featureAssetFinance: true })).status).toBe(403)
    expect((await GET(new NextRequest("http://localhost/api/settings/asset-finance"))).status).toBe(403)
    expect(m.update).not.toHaveBeenCalled()
  })

  it("reads the values, the legal gate and demo-lender marker included, with schema defaults for a tenant with no row", async () => {
    m.findUnique.mockResolvedValue(null)
    expect(await (await GET(new NextRequest("http://localhost/api/settings/asset-finance"))).json()).toEqual(current)
  })

  it("switches the module on: one audit row with old and new, and the cached config invalidated", async () => {
    const res = await patch({ featureAssetFinance: true })
    expect(res.status).toBe(200)
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-1" }, data: { featureAssetFinance: true } }))
    expect(m.create).not.toHaveBeenCalled()
    expect(m.executeRaw).toHaveBeenCalledTimes(2)
    expect(m.executeRaw.mock.invocationCallOrder[1]).toBeLessThan(m.findUnique.mock.invocationCallOrder[0])
    expect(m.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_FINANCE_MODULE_ENABLED", entity: "TenantConfig", entityId: "tenant-1", userId: "admin-1",
      oldValue: { featureAssetFinance: false }, newValue: { featureAssetFinance: true },
    }), expect.anything())
    expect(m.revalidateTag).toHaveBeenCalledWith("tenant-config-tenant-1", "max")
  })

  it("audits a threshold change on its own action and nothing when a value is unchanged", async () => {
    await patch({ featureAssetFinance: false, assetPayoutDualApprovalCents: 25_000_000 })
    expect(m.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_PAYOUT_DUAL_APPROVAL_CHANGED",
      oldValue: { assetPayoutDualApprovalCents: 100_000_000 }, newValue: { assetPayoutDualApprovalCents: 25_000_000 },
    }), expect.anything())
  })

  it("refuses to set the legal-wording approval 400, writing nothing", async () => {
    const res = await patch({ assetFinanceLegalWordingApproved: true })
    expect(res.status).toBe(400)
    expect((await res.json()).fields.assetFinanceLegalWordingApproved).toMatch(/set by CredaFlow/)
    expect(m.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).not.toHaveBeenCalled()
  })

  it("refuses an invalid threshold 400", async () => {
    expect((await patch({ assetPayoutDualApprovalCents: -5 })).status).toBe(400)
    expect(m.update).not.toHaveBeenCalled()
  })

  it("switches the dealer portal on and sets the clawback window, each audited on its own action", async () => {
    const res = await patch({ featureDealerPortal: true, dealerCommissionClawbackMonths: 12 })
    expect(res.status).toBe(200)
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { featureDealerPortal: true, dealerCommissionClawbackMonths: 12 } }))
    expect(m.logAuditStrict).toHaveBeenCalledTimes(2)
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "DEALER_PORTAL_ENABLED", oldValue: { featureDealerPortal: false }, newValue: { featureDealerPortal: true },
    }), expect.anything())
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "DEALER_CLAWBACK_MONTHS_CHANGED", oldValue: { dealerCommissionClawbackMonths: 0 }, newValue: { dealerCommissionClawbackMonths: 12 },
    }), expect.anything())
  })

  it("audits switching the dealer portal off", async () => {
    m.findUnique.mockResolvedValue({ ...current, featureDealerPortal: true, isDemoLender: true })
    await patch({ featureDealerPortal: false })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "DEALER_PORTAL_DISABLED" }), expect.anything())
  })

  it("answers the demo-only CHECK 422 with the reason, and audits nothing", async () => {
    m.update.mockRejectedValue(Object.assign(new Error(
      'new row for relation "TenantConfig" violates check constraint "TenantConfig_dealer_portal_demo_only"',
    ), { code: "23514" }))
    const res = await patch({ featureDealerPortal: true })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe(
      "The dealer portal can be switched on only for a demo lender until dealer two-factor sign-in ships",
    )
    expect(m.logAuditStrict).not.toHaveBeenCalled()
  })

  it.each([[-1], [61], [2.5], ["12"]])("refuses clawback months %j 400", async (months) => {
    expect((await patch({ dealerCommissionClawbackMonths: months })).status).toBe(400)
    expect(m.update).not.toHaveBeenCalled()
  })

  it("never writes the demo-lender marker", async () => {
    await patch({ featureDealerPortal: true, isDemoLender: true })
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { featureDealerPortal: true } }))
  })

  it("creates the row only when the lender has none (an INSERT is checked against the demo-only CHECK first)", async () => {
    m.findUnique.mockResolvedValue(null)
    expect((await patch({ featureAssetFinance: true })).status).toBe(200)
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: "tenant-1", featureAssetFinance: true } }))
    expect(m.update).not.toHaveBeenCalled()
  })

  it("sets the tracker position retention, audited on its own action", async () => {
    const res = await patch({ telematicsPositionRetentionDays: 30 })
    expect(res.status).toBe(200)
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: { telematicsPositionRetentionDays: 30 } }))
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "TELEMATICS_RETENTION_CHANGED", oldValue: { telematicsPositionRetentionDays: 90 }, newValue: { telematicsPositionRetentionDays: 30 },
    }), expect.anything())
  })

  it("answers the retention range CHECK 422 with the reason, audits nothing, and refuses a non-number 400", async () => {
    m.update.mockRejectedValue(Object.assign(new Error(
      'new row for relation "TenantConfig" violates check constraint "TenantConfig_telematics_retention_range"',
    ), { code: "23514" }))
    const res = await patch({ telematicsPositionRetentionDays: 366 })
    expect(res.status).toBe(422)
    expect((await res.json()).fields).toEqual({ telematicsPositionRetentionDays: "Tracker positions are kept from 1 to 365 days; a longer period needs legal sign-off" })
    expect(m.logAuditStrict).not.toHaveBeenCalled()
    for (const days of [1.5, "90", null]) expect((await patch({ telematicsPositionRetentionDays: days })).status).toBe(400)
  })
})
