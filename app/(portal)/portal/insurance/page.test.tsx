import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getPortalTenantId: vi.fn(),
  clientFindFirst: vi.fn(),
  policyFindMany: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: mocks.getPortalTenantId }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: async () => ({ tradingName: "Acme Lending" }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: mocks.clientFindFirst },
    insurancePolicy: { findMany: mocks.policyFindMany },
  },
}))
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }))

import PortalInsurancePage from "./page"

// premiumAmount / sumAssured are DECIMAL columns holding RANDS, so Prisma hands
// them back as Decimal instances that stringify. Mimic that rather than passing
// plain JS numbers, so the test exercises the same coercion the page does.
function decimal(value: string) {
  return { toString: () => value, valueOf: () => Number(value) }
}

const BASE_POLICY = {
  id: "policy-1",
  policyNumber: "CL-0001",
  type: "CREDIT_LIFE",
  status: "ACTIVE",
  premiumAmount: decimal("85.50"),
  sumAssured: decimal("25000.00"),
  startDate: new Date("2026-03-01T00:00:00.000Z"),
  renewalDate: new Date("2027-03-01T00:00:00.000Z"),
  waitingPeriodEnds: null,
  insurer: null,
  insurer_rel: { name: "Clientele Life" },
  policySource: "STANDALONE",
}

describe("portal insurance list page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { email: "client@example.test" } })
    // The real next/navigation redirect() throws to halt rendering; a mock that
    // returns would let the page run on past the auth guard and mask a bug.
    mocks.redirect.mockImplementation((to: string) => {
      throw new Error(`NEXT_REDIRECT:${to}`)
    })
    mocks.getPortalTenantId.mockResolvedValue("tenant-1")
    mocks.clientFindFirst.mockResolvedValue({ id: "client-1" })
    mocks.policyFindMany.mockResolvedValue([BASE_POLICY])
  })

  // Guards the recurring rands-vs-cents defect: the DB stores rands but
  // formatZAR takes cents, so a missing * 100 renders R 85.50 as "R 0.86".
  it("renders insurance money as rands, not as if the column held cents", async () => {
    const html = renderToStaticMarkup(await PortalInsurancePage())

    expect(html).toContain("R 85.50")
    expect(html).toContain("R 25,000.00")
    // The exact strings a missing * 100 would produce.
    expect(html).not.toContain("R 0.86")
    expect(html).not.toContain("R 250.00")
  })

  it("scopes the policy query to the signed-in client AND the tenant", async () => {
    await PortalInsurancePage()

    expect(mocks.policyFindMany).toHaveBeenCalledOnce()
    expect(mocks.policyFindMany.mock.calls[0][0]).toMatchObject({
      where: { clientId: "client-1", tenantId: "tenant-1" },
    })
  })

  it("resolves the client by session email within the tenant", async () => {
    await PortalInsurancePage()

    expect(mocks.clientFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "client@example.test", tenantId: "tenant-1" },
      }),
    )
  })

  it("redirects an unauthenticated visitor to the portal login before querying policies", async () => {
    mocks.auth.mockResolvedValue(null)

    await expect(PortalInsurancePage()).rejects.toThrow("NEXT_REDIRECT:/portal/login")

    expect(mocks.redirect).toHaveBeenCalledWith("/portal/login")
    expect(mocks.policyFindMany).not.toHaveBeenCalled()
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
  })

  it("shows an empty state rather than a broken grid when the client has no policies", async () => {
    mocks.policyFindMany.mockResolvedValue([])

    const html = renderToStaticMarkup(await PortalInsurancePage())

    expect(html).toContain("No policies on this account yet")
    expect(html).not.toContain("CL-0001")
  })

  it("warns about an unexpired waiting period and stays silent once it has passed", async () => {
    mocks.policyFindMany.mockResolvedValue([
      { ...BASE_POLICY, waitingPeriodEnds: new Date(Date.now() + 30 * 86_400_000) },
    ])
    const active = renderToStaticMarkup(await PortalInsurancePage())
    expect(active).toContain("Waiting period ends")

    mocks.policyFindMany.mockResolvedValue([
      { ...BASE_POLICY, waitingPeriodEnds: new Date(Date.now() - 30 * 86_400_000) },
    ])
    const elapsed = renderToStaticMarkup(await PortalInsurancePage())
    expect(elapsed).not.toContain("Waiting period ends")
  })

  it("explains the frozen figure and flags a policy that is not in force", async () => {
    mocks.policyFindMany.mockResolvedValue([
      { ...BASE_POLICY, policySource: "BUNDLED_CREDIT_AGREEMENT", status: "LAPSED" },
    ])

    const html = renderToStaticMarkup(await PortalInsurancePage())

    expect(html).toContain("Cover at inception")
    expect(html).toContain("follows your outstanding loan balance")
    expect(html).toContain("not in force")
    expect(html).not.toContain("Renews")
  })

  it("keeps plain wording and no warning for a live standalone policy", async () => {
    const html = renderToStaticMarkup(await PortalInsurancePage())

    expect(html).toContain("Renews")
    expect(html).not.toContain("Cover at inception")
    expect(html).not.toContain("not in force")
  })

  it("falls back to the deprecated insurer string when no insurer relation is set", async () => {
    mocks.policyFindMany.mockResolvedValue([
      { ...BASE_POLICY, insurer_rel: null, insurer: "Guardrisk Life" },
    ])

    const html = renderToStaticMarkup(await PortalInsurancePage())

    expect(html).toContain("Guardrisk Life")
  })
})
