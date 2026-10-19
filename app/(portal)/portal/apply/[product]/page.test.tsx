import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ loanFindMany: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "lerato@example.test", role: "CLIENT" } })) }))
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: vi.fn(async () => ({ tradingName: "Acme Credit", ncrNumber: "NCRCP0" })) }))
vi.mock("@/lib/config/demo-mode", () => ({ demoLenderNote: () => null }))
vi.mock("@/lib/insurance/credit-life-offer", () => ({ creditLifeOfferFindFirstArgs: () => ({}) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findFirst: vi.fn(async () => ({
        id: "c1", firstName: "Lerato", lastName: "Synthetic", idNumber: "0000000000000", phone: "0000000000", email: "lerato@example.test",
        monthlyIncome: 1_800_000, monthlyExpenses: 800_000, debtObligations: [{ monthlyInstalment: 87_000 }],
      })),
    },
    loanProduct: {
      findFirst: vi.fn(async () => ({
        id: "p1", name: "Personal", code: "PERSONAL", productType: "PERSONAL", minAmount: 200_000, maxAmount: 10_000_000,
        minTermDays: 30, maxTermDays: 1_800, interestModel: "REDUCING_BALANCE",
      })),
    },
    insuranceProduct: { findFirst: vi.fn(async () => null) },
    // The real own-lender loader runs over these (lib/affordability/own-lender-debt-load.ts).
    loan: { findMany: (a: unknown) => h.loanFindMany(a) },
    loanApplication: { findMany: vi.fn(async () => []) },
    tenant: { findUnique: vi.fn(async () => ({ name: "Acme Credit" })) },
    tenantConfig: { findUnique: vi.fn(async () => ({ brandName: "Acme Credit", legalName: "Acme Credit (Pty) Ltd" })) },
  },
}))

import PortalApplyProductPage from "./page"

type Props = { client: { existingDebt: number }; qualification: { ndi: number } }
const render = async () => (await PortalApplyProductPage({ params: Promise.resolve({ product: "personal" }) })).props as Props

describe("portal apply product page", () => {
  beforeEach(() => { h.loanFindMany.mockReset().mockResolvedValue([]) })

  it("counts the client's own active loan with this lender in existing debt and the qualification", async () => {
    h.loanFindMany.mockResolvedValue([{
      id: "loan-1", clientId: "c1", reference: "LN-SYN-1", status: "ACTIVE", outstandingPrincipal: 500_000,
      daysInArrears: 60, arrearsAmount: 205_834,
      repaymentSchedule: [{ totalDue: 120_000 }, { totalDue: 102_917 }],
    }])
    const props = await render()
    expect(props.client.existingDebt).toBe(87_000 + 102_917)
    expect(props.qualification.ndi).toBe(1_800_000 - 800_000 - 87_000 - 102_917)
    expect(h.loanFindMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", clientId: "c1" })
  })

  it("changes nothing for a client with no loan with this lender", async () => {
    expect((await render()).client.existingDebt).toBe(87_000)
  })
})
