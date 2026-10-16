// @vitest-environment jsdom
// ?enquiry= prefills the message from the URL, which only the browser has. The
// server HTML and first client render keep the message empty; the prefill lands
// once hydrated, only once, and never over text the user already typed.
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { act as reactAct } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import ContactPage from "./page"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const PREFILL = "I'd like to enquire about invoice discounting for my business."
const page = () => <WebsiteIdentityProvider identity={ACME_LENDER}><ContactPage /></WebsiteIdentityProvider>
const textarea = (r: ReactTestRenderer) => r.root.findByType("textarea")

beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  delete env.IS_REACT_ACT_ENVIRONMENT
  window.history.replaceState(null, "", "/site/contact")
})

describe("contact page ?enquiry= prefill", () => {
  it("server-renders an empty message even when the URL asks for a prefill", () => {
    window.history.replaceState(null, "", "/site/contact?enquiry=invoice-discounting")
    expect(renderToString(page())).not.toContain("invoice discounting for my business")
  })

  it("prefills the message after mount", async () => {
    window.history.replaceState(null, "", "/site/contact?enquiry=invoice-discounting")
    let r!: ReactTestRenderer
    await act(async () => { r = create(page()) })
    expect(textarea(r).props.value).toBe(PREFILL)
  })

  it("leaves the message empty for an unknown enquiry key", async () => {
    window.history.replaceState(null, "", "/site/contact?enquiry=nope")
    let r!: ReactTestRenderer
    await act(async () => { r = create(page()) })
    expect(textarea(r).props.value).toBe("")
  })

  it("does not re-apply the prefill over what the user types or clears", async () => {
    window.history.replaceState(null, "", "/site/contact?enquiry=invoice-discounting")
    let r!: ReactTestRenderer
    await act(async () => { r = create(page()) })
    await act(async () => { textarea(r).props.onChange({ target: { value: "my own words" } }) })
    expect(textarea(r).props.value).toBe("my own words")
    await act(async () => { textarea(r).props.onChange({ target: { value: "" } }) })
    expect(textarea(r).props.value).toBe("")
  })

  it("hydrates the server HTML without a mismatch, then prefills", async () => {
    window.history.replaceState(null, "", "/site/contact?enquiry=invoice-discounting")
    const container = document.createElement("div")
    container.innerHTML = renderToString(page())
    const onRecoverableError = vi.fn()
    await reactAct(async () => { hydrateRoot(container, page(), { onRecoverableError }) })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.querySelector("textarea")?.value).toBe(PREFILL)
  })
})
