import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }))

import { PortalApplyProductClient } from "./PortalApplyProductClient"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

// The audit: Lerato typed R3,000 for the 30-Day Micro Loan (max R2,000) and the
// form refused it with native validation only — no message on the page.
describe("PortalApplyProductClient amount outside the product range", () => {
  let renderer!: ReactTestRenderer

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <PortalApplyProductClient
          lenderName="Acme Lending"
          ncrNumber="NCRCP00000"
          productKey="micro"
          product={{
            id: "p-micro", name: "30-Day Micro Loan", code: "MICRO30", productType: "MICRO",
            minAmount: 50_000, maxAmount: 200_000, minTermDays: 30, maxTermDays: 30,
          }}
          client={{
            firstName: "Synthetic", lastName: "Applicant", idNumber: "9912310000085", phone: "0820000301",
            email: "synthetic@example.test", monthlyIncome: 1_800_000, monthlyExpenses: 800_000, existingDebt: 87_000,
          }}
          qualification={null}
          creditLifeOffer={null}
        />,
      )
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  const text = () => JSON.stringify(renderer.toJSON())
  const typeAmount = (value: string) =>
    act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value } }))

  it("says in words what range is allowed when the amount is above the maximum", async () => {
    await typeAmount("3000")
    expect(text()).toContain("Enter an amount between R 500.00 and R 2,000.00.")
  })

  it("says so below the minimum too", async () => {
    await typeAmount("100")
    expect(text()).toContain("Enter an amount between R 500.00 and R 2,000.00.")
  })

  it("shows no error before anything is typed or for a valid amount", async () => {
    expect(text()).not.toContain("Enter an amount between")
    await typeAmount("2000")
    expect(text()).not.toContain("Enter an amount between")
  })
})
