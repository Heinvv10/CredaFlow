import { beforeEach, describe, expect, it, vi } from "vitest"

// The mocked findUnique behaves like the database: it honours whatever
// predicates it is given, so a lookup by id alone finds another lender's
// product. The session's tenant (the real helper) must be in the where clause.

const { getSession, productFindUnique } = vi.hoisted(() => ({ getSession: vi.fn(), productFindUnique: vi.fn() }))

const PRODUCTS = [
  { id: "prod-a", tenantId: "tenant-a", code: "A1" },
  { id: "prod-b", tenantId: "tenant-b", code: "B1" },
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
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ role: "ADMIN" })), redirectStaleSession: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanProduct: { findUnique: productFindUnique } } }))
// The asset-finance flag (product arrears terms) is read through the tenant
// config; off here, so the consumer form is what renders.
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  getTenantConfig: vi.fn(async () => null),
}))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))
vi.mock("@/components/products/LoanProductForm", () => ({ LoanProductForm: () => null }))

import EditLoanProductPage from "./page"

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({ user: { id: "u-a", role: "ADMIN", tenantId: "tenant-a" } })
  productFindUnique.mockReset().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = PRODUCTS.find((p) => Object.entries(where).every(([k, v]) => p[k as keyof typeof p] === v))
    return row
      ? { ...row, name: "Synthetic", productType: "PERSONAL", minAmount: 100, maxAmount: 1000, minTermDays: 30, maxTermDays: 60, interestRatePm: 0.05 }
      : null
  })
})

const page = (id: string) => EditLoanProductPage({ params: Promise.resolve({ id }) })

describe("loan product edit page", () => {
  it("opens a product of the admin's own lender", async () => {
    await expect(page("prod-a")).resolves.toBeTruthy()
  })

  it("404s on another lender's product id", async () => {
    await expect(page("prod-b")).rejects.toThrow("NOT_FOUND")
  })
})
