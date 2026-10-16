// @vitest-environment jsdom
// The wizard restores a sessionStorage draft and the ?step= URL param. Both are
// browser-only, so the server render and the first client render must show the
// blank/initialData step 1 and the restore must land afterwards (React #418
// otherwise). Server `initialData` (resume mode) always wins over the draft.
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { act as reactAct } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APPLICATION_WIZARD_STORAGE_KEY } from "./constants"
import { EMPTY_APPLICATION_WIZARD_DATA, type ApplicationWizardData } from "./types"

let params = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => params,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ApplicationWizard } from "./ApplicationWizard"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const wizard = (extra: Partial<Parameters<typeof ApplicationWizard>[0]> = {}) => (
  <ApplicationWizard mode="staff" clients={[]} products={[]} creditLifeOffer={null} {...extra} />
)

const withAmount = (appliedAmount: string): ApplicationWizardData => ({ ...EMPTY_APPLICATION_WIZARD_DATA, appliedAmount })

function seedDraft(appliedAmount: string) {
  window.sessionStorage.setItem(APPLICATION_WIZARD_STORAGE_KEY, JSON.stringify(withAmount(appliedAmount)))
}
const storedAmount = () =>
  JSON.parse(window.sessionStorage.getItem(APPLICATION_WIZARD_STORAGE_KEY) ?? "{}").appliedAmount

async function mount(extra: Partial<Parameters<typeof ApplicationWizard>[0]> = {}): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer
  await act(async () => { r = create(wizard(extra)) })
  return r
}

const headings = (r: ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "h2").map((n) => String(n.props.children))
beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  params = new URLSearchParams()
  window.sessionStorage.clear()
})
afterEach(() => {
  delete env.IS_REACT_ACT_ENVIRONMENT
})

describe("ApplicationWizard restore", () => {
  it("server-renders step 1 even when a draft and ?step= exist", () => {
    seedDraft("1234")
    params = new URLSearchParams("step=2")
    const html = renderToString(wizard())
    expect(html).toContain("Choose the client")
    expect(html).not.toContain("Applied amount (R)")
  })

  it("restores the draft and the URL step after mount", async () => {
    seedDraft("1234")
    params = new URLSearchParams("step=2")
    const r = await mount()
    expect(headings(r)).toContain("Loan parameters")
    expect(JSON.stringify(r.toJSON())).toContain('"1234"')
  })

  it("keeps the draft in storage rather than overwriting it with blank data", async () => {
    seedDraft("1234")
    await mount()
    expect(storedAmount()).toBe("1234")
  })

  it("fills in fields an older draft predates", async () => {
    window.sessionStorage.setItem(APPLICATION_WIZARD_STORAGE_KEY, JSON.stringify({ appliedAmount: "99" }))
    params = new URLSearchParams("step=2")
    const r = await mount()
    expect(JSON.stringify(r.toJSON())).toContain('"99"')
    expect(headings(r)).toContain("Loan parameters")
  })

  it("lets server initialData win over a stale draft when resuming, and leaves the draft alone", async () => {
    seedDraft("1234")
    params = new URLSearchParams("step=2")
    const r = await mount({ applicationId: "app1", initialData: withAmount("777") })
    const json = JSON.stringify(r.toJSON())
    expect(json).toContain('"777"')
    expect(json).not.toContain('"1234"')
    expect(storedAmount()).toBe("1234")
  })

  it("hydrates the server HTML without a mismatch, then applies the draft", async () => {
    seedDraft("1234")
    params = new URLSearchParams("step=2")
    const container = document.createElement("div")
    container.innerHTML = renderToString(wizard())
    const onRecoverableError = vi.fn()
    await reactAct(async () => { hydrateRoot(container, wizard(), { onRecoverableError }) })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Loan parameters")
    // The persistence effect also runs after the (blank) hydration commit; it
    // must not overwrite the draft before the restore has read it.
    expect(storedAmount()).toBe("1234")
  })

  it("follows the URL step when it changes (browser back/forward)", async () => {
    params = new URLSearchParams("step=2")
    const r = await mount()
    expect(headings(r)).toContain("Loan parameters")
    params = new URLSearchParams("step=1")
    await act(async () => { r.update(wizard()) })
    expect(headings(r)).toContain("Choose the client")
  })
})
