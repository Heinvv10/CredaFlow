// @vitest-environment jsdom
// The apply page restores a saved draft and URL prefill from the browser. The
// server HTML and the first client render must be the blank step 1 (React #418
// otherwise); the restore lands once hydrated, and the persistence effect must
// not overwrite the saved draft with blank defaults before that.
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { act as reactAct } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { APPLY_DRAFT_KEY } from "@/lib/draft-keys"

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/apply",
}))
vi.mock("@/lib/use-live-pricing", () => ({ useLivePricing: () => ({ pricing: {}, loading: false }) }))

import ApplyPage from "./page"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const page = () => <WebsiteIdentityProvider identity={ACME_LENDER}><ApplyPage /></WebsiteIdentityProvider>

function seedDraft() {
  window.localStorage.setItem(
    APPLY_DRAFT_KEY,
    JSON.stringify({
      step: 2,
      step1: { firstName: "Zed", lastName: "Tester" },
      updatedAt: new Date().toISOString(),
    }),
  )
}
const storedFirstName = () => JSON.parse(window.localStorage.getItem(APPLY_DRAFT_KEY) ?? "{}").step1?.firstName

beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  window.history.replaceState(null, "", "/site/apply")
})
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT })

describe("apply page draft restore", () => {
  it("server-renders step 1 with no restore banner even when a draft exists", () => {
    seedDraft()
    const html = renderToString(page())
    expect(html).toContain("Step 1 of 3")
    expect(html).not.toContain("We restored the details")
  })

  it("restores the saved step and shows the banner after mount", async () => {
    seedDraft()
    let r!: ReactTestRenderer
    await act(async () => { r = create(page()) })
    const text = JSON.stringify(r.toJSON())
    expect(text).toContain("Step 2 of 3")
    expect(text).toContain("We restored the details")
  })

  it("restores URL prefill (amount) when there is no draft", async () => {
    window.history.replaceState(null, "", "/site/apply?amount=3000")
    let r!: ReactTestRenderer
    await act(async () => { r = create(page()) })
    expect(JSON.stringify(r.toJSON())).toContain("We restored the details")
  })

  it("keeps the saved draft intact instead of persisting blank defaults first", async () => {
    seedDraft()
    await act(async () => { create(page()) })
    expect(storedFirstName()).toBe("Zed")
  })

  it("hydrates the server HTML without a mismatch, then applies the draft", async () => {
    seedDraft()
    const container = document.createElement("div")
    container.innerHTML = renderToString(page())
    const onRecoverableError = vi.fn()
    await reactAct(async () => { hydrateRoot(container, page(), { onRecoverableError }) })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Step 2 of 3")
    expect(storedFirstName()).toBe("Zed")
  })
})
