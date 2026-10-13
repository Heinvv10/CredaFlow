import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Pages run outside a tenant-scope frame, so the page's own where clause is
// the tenant boundary (the mocked Prisma does not run the extension). The
// mocked findFirst behaves like the database: it honours whatever predicates
// it is given, so a lookup by id alone finds another lender's policy.

const { getSession, policyFindFirst } = vi.hoisted(() => ({ getSession: vi.fn(), policyFindFirst: vi.fn() }))

const POLICIES = [
  { id: "pol-a", tenantId: "tenant-a", policyNumber: "POL-A-0001" },
  { id: "pol-b", tenantId: "tenant-b", policyNumber: "POL-B-0001" },
]

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND")
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))
vi.mock("@/lib/auth-session", () => ({ getSession }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { insurancePolicy: { findFirst: policyFindFirst } } }))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))
vi.mock("@/components/insurance/PolicyDetailClient", () => ({
  PolicyDetailClient: ({ policy }: { policy: { policyNumber: string } }) => <p>{policy.policyNumber}</p>,
}))

import PolicyDetailPage from "./page"

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({ user: { id: "u-a", role: "INSURANCE_OFFICER", tenantId: "tenant-a" } })
  policyFindFirst.mockReset().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = POLICIES.find((p) => Object.entries(where).every(([k, v]) => p[k as keyof typeof p] === v))
    return row
      ? { ...row, premiumAmount: 1, sumAssured: 1, commissionRate: 0, commissionAmount: null, claims: [], premiumPayments: [], beneficiaries: [] }
      : null
  })
})

const page = (id: string) => PolicyDetailPage({ params: Promise.resolve({ id }) })

describe("staff policy detail page", () => {
  it("renders a policy of the staff member's own lender", async () => {
    expect(renderToStaticMarkup(await page("pol-a"))).toContain("POL-A-0001")
  })

  it("404s on another lender's policy id", async () => {
    await expect(page("pol-b")).rejects.toThrow("NOT_FOUND")
  })
})
