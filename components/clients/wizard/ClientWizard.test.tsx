// @vitest-environment jsdom
// The wizard restores a sessionStorage draft and the ?step= URL param. Both are
// browser-only, so the server render and the first client render must show the
// blank step 1 and the restore must land afterwards (React #418 otherwise).
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { act as reactAct } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLIENT_WIZARD_STORAGE_KEY } from "./constants"
import { EMPTY_CLIENT_WIZARD_DATA } from "./types"

let params = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => params,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ClientWizard } from "./ClientWizard"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function seedDraft(firstName: string) {
  window.sessionStorage.setItem(
    CLIENT_WIZARD_STORAGE_KEY,
    JSON.stringify({ ...EMPTY_CLIENT_WIZARD_DATA, firstName }),
  )
}

async function mount(): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer
  await act(async () => { r = create(<ClientWizard mode="staff" />) })
  return r
}

const headings = (r: ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "h2").map((n) => String(n.props.children))
const firstNameValue = (r: ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "input" && n.props.autoComplete === "given-name")[0]?.props.value

beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  params = new URLSearchParams()
  window.sessionStorage.clear()
})
afterEach(() => {
  delete env.IS_REACT_ACT_ENVIRONMENT
})

describe("ClientWizard restore", () => {
  it("server-renders the blank step 1 even when a draft and ?step= exist", () => {
    seedDraft("Zed")
    params = new URLSearchParams("step=2")
    const html = renderToString(<ClientWizard mode="staff" />)
    expect(html).toContain("Identity")
    expect(html).not.toContain("Residential address")
    expect(html).not.toContain("Zed")
  })

  it("restores the draft into the form after mount", async () => {
    seedDraft("Zed")
    expect(firstNameValue(await mount())).toBe("Zed")
  })

  it("restores the step from ?step= after mount", async () => {
    params = new URLSearchParams("step=2")
    expect(headings(await mount())).toContain("Residential address")
  })

  it("does not overwrite the saved draft with blank data before restoring", async () => {
    seedDraft("Zed")
    await mount()
    expect(JSON.parse(window.sessionStorage.getItem(CLIENT_WIZARD_STORAGE_KEY) ?? "{}").firstName).toBe("Zed")
  })

  it("hydrates the server HTML without a mismatch, then applies the draft", async () => {
    seedDraft("Zed")
    params = new URLSearchParams("step=2")
    const container = document.createElement("div")
    container.innerHTML = renderToString(<ClientWizard mode="staff" />)
    const onRecoverableError = vi.fn()
    await reactAct(async () => { hydrateRoot(container, <ClientWizard mode="staff" />, { onRecoverableError }) })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Residential address")
    // The persistence effect also runs after the (blank) hydration commit; it
    // must not overwrite the draft before the restore has read it.
    expect(JSON.parse(window.sessionStorage.getItem(CLIENT_WIZARD_STORAGE_KEY) ?? "{}").firstName).toBe("Zed")
  })

  it("follows the URL step when it changes (browser back/forward)", async () => {
    params = new URLSearchParams("step=3")
    const r = await mount()
    expect(headings(r)).toContain("Employment & income")
    params = new URLSearchParams("step=1")
    await act(async () => { r.update(<ClientWizard mode="staff" />) })
    expect(headings(r)).toContain("Identity")
  })
})
