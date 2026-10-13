import { beforeEach, describe, expect, it, vi } from "vitest"

// The CRM module switch is the SESSION tenant's (lib/session-tenant.ts, real
// here), as the dashboard layout and the pages beneath read it. The host's
// tenant (getTenantFeatures / getResolvedTenantId) has the opposite flag in
// each case below, so a layout that read the host's would fail.

const { getSession, getTenantConfig, getTenantFeatures } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getTenantConfig: vi.fn(),
  getTenantFeatures: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))
vi.mock("@/lib/auth-session", () => ({ getSession }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantConfig,
  getTenantFeatures,
  getResolvedTenantId: vi.fn(async () => "tenant-host"),
  getDefaultTenantId: vi.fn(async () => "tenant-default"),
}))

import CrmLayout from "./layout"

const CONFIG = { featureIms: false, featureBureauSubmission: false }

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({ user: { id: "u-1", role: "LOAN_ADMIN", tenantId: "tenant-session" } })
  getTenantConfig.mockReset()
  getTenantFeatures.mockReset()
})

describe("CRM layout feature gate", () => {
  it("CRM off for the session's lender (on for the host's) → redirected away", async () => {
    getTenantConfig.mockImplementation(async (t: string) => ({ ...CONFIG, featureCrm: t !== "tenant-session" }))
    getTenantFeatures.mockResolvedValue({ featureCrm: true, featureIms: false, featureBureauSubmission: false })
    await expect(CrmLayout({ children: "crm" })).rejects.toThrow("REDIRECT:/dashboard")
  })

  it("CRM on for the session's lender (off for the host's) → rendered", async () => {
    getTenantConfig.mockImplementation(async (t: string) => ({ ...CONFIG, featureCrm: t === "tenant-session" }))
    getTenantFeatures.mockResolvedValue({ featureCrm: false, featureIms: false, featureBureauSubmission: false })
    await expect(CrmLayout({ children: "crm" })).resolves.toBeTruthy()
    expect(getTenantConfig).toHaveBeenCalledWith("tenant-session")
  })
})
