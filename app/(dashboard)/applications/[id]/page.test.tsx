import { beforeEach, describe, expect, it, vi } from "vitest"
import ApplicationDetailPage from "./page"

const mocks = vi.hoisted(() => ({ application: vi.fn(), config: vi.fn(), auth: vi.fn(), redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findUnique: mocks.application }, tenantConfig: { findUnique: mocks.config } } }))
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: async () => "tenant-synthetic" }))
vi.mock("@/lib/security/segregation-of-duties", () => ({ isSegregationOfDutiesRequired: async () => true }))
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: () => { throw new Error("NOT_FOUND") } }))

describe("asset-finance application routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.config.mockResolvedValue({ collectionsEngineEnabled: false, payoutsEngineEnabled: true })
    mocks.auth.mockResolvedValue({ user: { role: "ADMIN" } })
    mocks.redirect.mockImplementation((url: string) => { throw new Error(`REDIRECT:${url}`) })
  })
  it.each(["client-synthetic", null])("routes borrower clientId=%s to the linked deal before consumer evidence is evaluated", async (clientId) => {
    mocks.application.mockResolvedValue({ id: "application-synthetic", clientId, client: clientId ? { id: clientId } : null, assetFinanceDeal: { id: "deal-synthetic" } })
    await expect(ApplicationDetailPage({ params: Promise.resolve({ id: "application-synthetic" }) }))
      .rejects.toThrow("REDIRECT:/asset-finance/deals/deal-synthetic")
    expect(mocks.application).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "application-synthetic", tenantId: "tenant-synthetic" } }))
  })
})
