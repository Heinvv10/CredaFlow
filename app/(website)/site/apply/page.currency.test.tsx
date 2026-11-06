// @vitest-environment jsdom
// Step 2 of the website application asks for income and expenses; the labels name the lender's currency.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { APPLY_DRAFT_KEY } from "@/lib/draft-keys"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/apply",
}))
vi.mock("@/lib/use-live-pricing", () => ({ useLivePricing: () => ({ pricing: {}, loading: false }) }))

import ApplyPage from "./page"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("")

async function step2Text(): Promise<string> {
  window.localStorage.setItem(APPLY_DRAFT_KEY, JSON.stringify({ step: 2, step1: { firstName: "Zed" }, updatedAt: new Date().toISOString() }))
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<WebsiteIdentityProvider identity={ACME_LENDER}><ApplyPage /></WebsiteIdentityProvider>)
  })
  return text(renderer.root)
}

beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  window.history.replaceState(null, "", "/site/apply")
})
afterEach(() => { resetActiveJurisdiction(); delete env.IS_REACT_ACT_ENVIRONMENT })

describe("website apply step 2 labels", () => {
  it("name rand for ZA and loti for LS", async () => {
    const za = await step2Text()
    expect(za).toContain("Monthly Income (R)")
    expect(za).toContain("Total Monthly Expenses (R)")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const ls = await step2Text()
    expect(ls).toContain("Monthly Income (M)")
    expect(ls).toContain("Total Monthly Expenses (M)")
    expect(ls).not.toContain("(R)")
  })
})
