// @vitest-environment jsdom
// The qualify wizard saves a draft the apply form later restores. Opening the
// page without entering anything must not save one: an untouched default draft
// made the apply form announce "We restored the details you already entered"
// over blank fields.
import { act, create } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { QUALIFY_DRAFT_KEY } from "@/lib/draft-keys"

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/qualify",
}))
vi.mock("@/lib/use-live-pricing", () => ({ useLivePricing: () => ({ pricing: {}, loading: false }) }))

import QualifyPage from "./page"
import ApplyPage from "../apply/page"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const wrap = (el: React.ReactNode) => <WebsiteIdentityProvider identity={ACME_LENDER}>{el}</WebsiteIdentityProvider>
const storedDraft = () => JSON.parse(window.localStorage.getItem(QUALIFY_DRAFT_KEY) ?? "null")

beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  window.history.replaceState(null, "", "/site/qualify")
})
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT })

describe("qualify draft", () => {
  it("saves nothing when the visitor has entered nothing", async () => {
    await act(async () => { create(wrap(<QualifyPage />)) })
    expect(storedDraft()).toBeNull()
  })

  it("keeps a saved draft the visitor entered earlier", async () => {
    window.localStorage.setItem(QUALIFY_DRAFT_KEY, JSON.stringify({
      stepOne: { employmentStatus: "EMPLOYED", monthlyIncome: "12000", monthlyExpenses: "4000" },
      updatedAt: new Date().toISOString(),
    }))
    await act(async () => { create(wrap(<QualifyPage />)) })
    expect(storedDraft().stepOne.monthlyIncome).toBe("12000")
  })

  it("an untouched visit does not make the apply form claim it restored details", async () => {
    await act(async () => { create(wrap(<QualifyPage />)) })
    window.history.replaceState(null, "", "/site/apply")
    let r!: ReturnType<typeof create>
    await act(async () => { r = create(wrap(<ApplyPage />)) })
    const text = JSON.stringify(r.toJSON())
    expect(text).toContain("Step 1 of 3")
    expect(text).not.toContain("We restored the details")
  })
})
