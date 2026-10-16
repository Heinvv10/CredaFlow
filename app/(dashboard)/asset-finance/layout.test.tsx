import { beforeEach, describe, expect, it, vi } from "vitest"

// The asset-finance section gate reads the flag of the SESSION's tenant (the
// tenant the pages query), not one resolved from the request host (review L7).
const m = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`)
  }),
  requireMinRole: vi.fn(),
  getTenantConfig: vi.fn(),
  getTenantFeatures: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: m.redirect }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: m.requireMinRole, canDo: () => false, requireLoanBookPage: async () => undefined }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantConfig: m.getTenantConfig,
  getTenantFeatures: m.getTenantFeatures,
}))

import AssetFinanceLayout from "./layout"

const render = () => AssetFinanceLayout({ children: "page" })
const flags = (featureAssetFinance: boolean) => ({ featureCrm: false, featureIms: false, featureAssetFinance })

beforeEach(() => {
  vi.clearAllMocks()
  m.requireMinRole.mockResolvedValue({ id: "user-1", email: "u@lender.test", role: "READONLY", tenantId: "tenant-session" })
  // A host-resolved tenant that disagrees with the session must not decide.
  m.getTenantFeatures.mockResolvedValue({ featureCrm: false, featureIms: false, featureBureauSubmission: false, featureAssetFinance: true })
})

describe("asset-finance layout", () => {
  it("reads the flag of the session's tenant", async () => {
    m.getTenantConfig.mockResolvedValue(flags(true))
    await expect(render()).resolves.toBeTruthy()
    expect(m.getTenantConfig).toHaveBeenCalledWith("tenant-session")
    expect(m.getTenantFeatures).not.toHaveBeenCalled()
  })

  it("redirects when the session tenant has asset finance off, whatever the host's tenant says", async () => {
    m.getTenantConfig.mockResolvedValue(flags(false))
    await expect(render()).rejects.toThrow("REDIRECT:/dashboard")
  })

  it("redirects when the session tenant has no config row", async () => {
    m.getTenantConfig.mockResolvedValue(null)
    await expect(render()).rejects.toThrow("REDIRECT:/dashboard")
  })
})
