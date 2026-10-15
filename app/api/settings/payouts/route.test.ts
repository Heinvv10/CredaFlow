import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditCreate: vi.fn(),
  totpRequired: vi.fn(),
}))

vi.mock("@/lib/prisma", () => {
  const tenantConfig = { findUnique: (...a: unknown[]) => h.findUnique(...a), upsert: (...a: unknown[]) => h.upsert(...a) }
  const auditLog = { create: (...a: unknown[]) => h.auditCreate(...a) }
  return { prisma: { tenantConfig, auditLog, $transaction: async (fn: (tx: unknown) => unknown) => fn({ tenantConfig, auditLog }) } }
})
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: { id: "admin-1", email: "admin@test.invalid", role: "ADMIN", totpVerified: true } })),
}))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t-1" }) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: (...a: unknown[]) => h.totpRequired(...a) }))

import { GET, PATCH } from "./route"

const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/settings/payouts", { method: "PATCH", body: JSON.stringify(body) }))

beforeEach(() => {
  h.findUnique.mockResolvedValue({ payoutsEngineEnabled: false, payoutProvider: null })
  h.upsert.mockImplementation(async ({ update }: { update: object }) => update)
  h.auditCreate.mockResolvedValue({})
  h.totpRequired.mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("PATCH /api/settings/payouts", () => {
  it("refuses the simulated channel on a deployed build that does not declare it", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const res = await patch({ payoutsEngineEnabled: true, payoutProvider: "simulated" })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/only simulate/)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("refuses Netcash while it is in dry-run on a deployed build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NETCASH_DRY_RUN", "true")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const res = await patch({ payoutsEngineEnabled: false, payoutProvider: "netcash" })
    expect(res.status).toBe(422)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("saves a usable channel and audits the change", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NETCASH_DRY_RUN", "false")
    const res = await patch({ payoutsEngineEnabled: true, payoutProvider: "netcash" })
    expect(res.status).toBe(200)
    expect(h.upsert).toHaveBeenCalledOnce()
    expect(h.auditCreate.mock.calls[0][0].data).toMatchObject({ action: "PAYOUT_SETTINGS_UPDATED", entity: "TenantConfig" })
  })

  it("says which channels cannot be used here, and why", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const json = await (await GET(new NextRequest("http://localhost/api/settings/payouts"))).json()
    const byId = Object.fromEntries(json.providers.map((p: { id: string; unavailableReason: string | null }) => [p.id, p.unavailableReason]))
    expect(byId.simulated).toMatch(/only simulate/)
    expect(byId.payshap).toMatch(/not implemented/)
  })
})
