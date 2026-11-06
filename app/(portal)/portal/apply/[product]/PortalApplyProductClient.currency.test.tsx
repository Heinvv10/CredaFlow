import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }))

import { PortalApplyProductClient } from "./PortalApplyProductClient"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("")

async function screen(ncaDeclarations: boolean): Promise<string> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      <PortalApplyProductClient
        lenderName="Demo Lender" ncrNumber="NCRCP00000" productKey="micro" ncaDeclarations={ncaDeclarations}
        product={{ id: "p", name: "Micro", code: "M30", productType: "MICRO", minAmount: 50_000, maxAmount: 200_000, minTermDays: 30, maxTermDays: 30 }}
        client={{ firstName: "Synthetic", lastName: "Applicant", idNumber: "9912310000085", phone: "0820000301", email: "s@example.test", monthlyIncome: 1_800_000, monthlyExpenses: 800_000, existingDebt: 87_000 }}
        qualification={null}
        creditLifeOffer={null}
      />,
    )
  })
  return text(renderer.root)
}

beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { resetActiveJurisdiction(); delete env.IS_REACT_ACT_ENVIRONMENT })

describe("PortalApplyProductClient amount label follows the lender's currency", () => {
  it("NCA application: Amount (R) for ZA, Amount (M) for LS", async () => {
    expect(await screen(true)).toContain("Amount (R) — between")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const ls = await screen(true)
    expect(ls).toContain("Amount (M) — between")
    expect(ls).not.toContain("(R)")
  })

  it("key-facts application drops the symbol from the label under both currencies", async () => {
    const za = await screen(false)
    expect(za).toContain("Amount — between")
    expect(za).not.toContain("(R)")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const ls = await screen(false)
    expect(ls).toContain("Amount — between")
    expect(ls).not.toContain("(M)")
  })
})
