import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// InsurancePolicy, InsuranceClaim, PremiumPayment, CrossSellOpportunity and
// User carry a tenantId, and pages run outside a tenant frame: each list
// page's where clause is its tenant boundary. (User is not a tenant-scope
// model; the other four are, but the mocked Prisma does not run the extension.)
// The mocked queries behave like the database — they apply the filters they
// are given, and nothing else — so a query without the tenant returns the
// other lender's rows too. The session tenant comes from the real helper.

type Row = Record<string, unknown>

const { db, getSession, captured, table } = vi.hoisted(() => {
  type HRow = Record<string, unknown>
  type Where = Record<string, unknown>
  const db = {} as Record<string, HRow[]>
  const matches = (row: HRow, where: Where = {}) =>
    Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === "object" && "in" in cond) return (cond.in as unknown[]).includes(row[key])
      return row[key] === cond
    })
  const table = (name: string) => ({
    findMany: vi.fn(async (args: { where?: Where } = {}) => db[name].filter((r) => matches(r, args.where))),
    aggregate: vi.fn(async (args: { where?: Where } = {}) => ({
      _sum: { amount: db[name].filter((r) => matches(r, args.where)).reduce((s, r) => s + (r.amount as number), 0) },
    })),
  })
  return { db, getSession: vi.fn(), captured: {} as Record<string, unknown>, table }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    insurancePolicy: table("insurancePolicy"),
    insuranceClaim: table("insuranceClaim"),
    premiumPayment: table("premiumPayment"),
    crossSellOpportunity: table("crossSellOpportunity"),
    user: table("user"),
    loanProduct: table("loanProduct"),
    client: table("client"),
    insuranceProduct: table("insuranceProduct"),
  },
}))
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/lib/auth-session", () => ({ getSession }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ role: "LOAN_ADMIN" })), redirectStaleSession: vi.fn() }))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))
vi.mock("@/components/insurance/InsuranceDashboardClient", () => ({
  InsuranceDashboardClient: (props: unknown) => {
    captured.insurance = props
    return null
  },
}))
vi.mock("@/components/crm/OpportunitiesClient", () => ({
  OpportunitiesClient: (props: unknown) => {
    captured.opportunities = props
    return null
  },
}))
vi.mock("@/components/insurance/PolicyCreationWizard", () => ({
  PolicyCreationWizard: (props: unknown) => {
    captured.wizard = props
    return null
  },
}))

import InsurancePage from "./insurance/page"
import NewPolicyPage from "./insurance/new/page"
import OpportunitiesPage from "./crm/opportunities/page"
import SettingsPage from "./settings/page"

const policy = (id: string, tenantId: string): Row => ({
  id, tenantId, status: "ACTIVE", premiumAmount: 100, sumAssured: 1000, commissionRate: 0.1, commissionAmount: 10, claims: [],
})
const claim = (id: string, tenantId: string): Row => ({ id, tenantId, status: "SUBMITTED", claimAmount: 50, approvedAmount: null })
const user = (id: string, tenantId: string, email: string): Row => ({
  id, tenantId, email, name: email, role: "LOAN_ADMIN", active: true, createdAt: new Date("2026-07-01T00:00:00Z"),
})

beforeEach(() => {
  for (const key of Object.keys(captured)) delete captured[key]
  getSession.mockReset().mockResolvedValue({ user: { id: "u-a", role: "LOAN_ADMIN", tenantId: "tenant-a" } })
  db.insurancePolicy = [policy("pol-a", "tenant-a"), policy("pol-b", "tenant-b")]
  db.insuranceClaim = [claim("clm-a", "tenant-a"), claim("clm-b", "tenant-b")]
  db.premiumPayment = [
    { id: "pp-a", tenantId: "tenant-a", status: "PAID", amount: 300 },
    { id: "pp-b", tenantId: "tenant-b", status: "PAID", amount: 7000 },
  ]
  db.crossSellOpportunity = [{ id: "opp-a", tenantId: "tenant-a" }, { id: "opp-b", tenantId: "tenant-b" }]
  db.user = [user("u-a", "tenant-a", "staff@lender-a.test"), user("u-b", "tenant-b", "staff@lender-b.test")]
  db.loanProduct = []
  db.client = []
  db.insuranceProduct = []
})

const ids = (rows: unknown) => (rows as Row[]).map((r) => r.id)

describe("insurance dashboard", () => {
  it("lists only the session lender's policies, claims and collected premiums", async () => {
    renderToStaticMarkup(await InsurancePage())
    const data = captured.insurance as { policies: Row[]; claims: Row[]; totalCollected: number; monthlyPremiums: number }
    expect(ids(data.policies)).toEqual(["pol-a"])
    expect(ids(data.claims)).toEqual(["clm-a"])
    expect(data.totalCollected).toBe(300)
    expect(data.monthlyPremiums).toBe(100)
  })
})

describe("new policy page", () => {
  it("offers only the session lender's staff as advisors", async () => {
    renderToStaticMarkup(await NewPolicyPage())
    expect(ids((captured.wizard as { advisors: Row[] }).advisors)).toEqual(["u-a"])
  })
})

describe("cross-sell opportunities", () => {
  it("lists only the session lender's opportunities", async () => {
    renderToStaticMarkup(await OpportunitiesPage())
    expect(ids((captured.opportunities as { opportunities: Row[] }).opportunities)).toEqual(["opp-a"])
  })
})

describe("settings page", () => {
  // The page renders the user count, not the users.
  it("counts only the session lender's users", async () => {
    const html = renderToStaticMarkup(await SettingsPage())
    expect(html).toContain("1 registered user — 1 active")
  })
})
