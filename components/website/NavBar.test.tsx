// @vitest-environment jsdom
// The marketing Login link carries ?callbackUrl=/portal when this browser holds
// an application draft. The server cannot see localStorage, so the server HTML
// and the hydration render must both say "no draft"; the browser's answer lands
// after. Reading localStorage in a useState initializer broke that: the first
// client render disagreed with the server and React reported a mismatch.
import { act } from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { I18nProvider } from "@/lib/i18n/client"
import { APPLY_DRAFT_KEY } from "@/lib/draft-keys"
import { WebsiteIdentityProvider } from "./WebsiteIdentity"
import NavBar from "./NavBar"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/apply",
  useSearchParams: () => new URLSearchParams(),
}))

const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const roots = new Set<ReturnType<typeof hydrateRoot>>()

function Shell() {
  return (
    <I18nProvider locale="en" messages={{}}>
      <WebsiteIdentityProvider identity={ACME_LENDER}>
        <NavBar />
      </WebsiteIdentityProvider>
    </I18nProvider>
  )
}

const loginHrefs = (root: ParentNode) =>
  [...root.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").filter((h) => h.includes("/portal/login"))

beforeEach(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.innerHTML = ""
  window.localStorage.clear()
  delete g.IS_REACT_ACT_ENVIRONMENT
  vi.restoreAllMocks()
})

describe("NavBar login link and the application draft", () => {
  it("renders the plain login link on the server even when the browser holds a draft", () => {
    window.localStorage.setItem(APPLY_DRAFT_KEY, "{}")
    const container = document.createElement("div")
    container.innerHTML = renderToString(<Shell />)
    expect(loginHrefs(container).length).toBeGreaterThan(0)
    for (const href of loginHrefs(container)) expect(href).not.toContain("callbackUrl")
  })

  it("hydrates over that HTML without a mismatch, then links to the portal callback", async () => {
    // The real server has no localStorage: its HTML is rendered with no draft
    // in sight. The draft exists only in the browser that hydrates it.
    const html = renderToString(<Shell />)
    window.localStorage.setItem(APPLY_DRAFT_KEY, "{}")
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)

    const recoverable = vi.fn()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await act(async () => { roots.add(hydrateRoot(container, <Shell />, { onRecoverableError: recoverable })) })

    const mismatch = consoleError.mock.calls.some((args) => String(args[0]).includes("hydrat"))
    consoleError.mockRestore()
    expect(recoverable).not.toHaveBeenCalled()
    expect(mismatch).toBe(false)
    expect(loginHrefs(container).every((h) => h.includes("callbackUrl=%2Fportal"))).toBe(true)
  })

  it("follows a draft saved or cleared after mount", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    container.innerHTML = renderToString(<Shell />)
    await act(async () => { roots.add(hydrateRoot(container, <Shell />)) })
    expect(loginHrefs(container).some((h) => h.includes("callbackUrl"))).toBe(false)

    await act(async () => {
      window.localStorage.setItem(APPLY_DRAFT_KEY, "{}")
      window.dispatchEvent(new Event("lms:draft-updated"))
    })
    expect(loginHrefs(container).every((h) => h.includes("callbackUrl"))).toBe(true)

    await act(async () => {
      window.localStorage.removeItem(APPLY_DRAFT_KEY)
      window.dispatchEvent(new Event("storage"))
    })
    expect(loginHrefs(container).some((h) => h.includes("callbackUrl"))).toBe(false)
  })
})
