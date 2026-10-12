// @vitest-environment jsdom
// A real DOM (react-dom createRoot) so the Radix switch is clicked the way a
// browser clicks it, and its aria-checked / disabled state is what is read.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }))

import { BankSyncToggle } from "./BankSyncToggle"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  refreshMock.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<BankSyncToggle bankSyncEnabled={false} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

function toggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[role="switch"]')!
}

async function click() {
  await act(async () => toggle().click())
}

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl)
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("BankSyncToggle", () => {
  it("flips on, says so and refreshes the server data when the save succeeds", async () => {
    const fetchMock = stubFetch(async () => Response.json({ ok: true, bankSyncEnabled: true }))

    await click()

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/bank-sync", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ bankSyncEnabled: true }),
    }))
    expect(toggle().getAttribute("aria-checked")).toBe("true")
    expect(container.textContent).toContain("Bank statement import switched on.")
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it("shows the server's error and stays off when the save is refused", async () => {
    stubFetch(async () => Response.json({ error: "Sign in with two-factor authentication" }, { status: 403 }))

    await click()

    expect(toggle().getAttribute("aria-checked")).toBe("false")
    expect(container.textContent).toContain("Sign in with two-factor authentication")
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("falls back to a generic error when a refused response is not JSON", async () => {
    stubFetch(async () => new Response("<html>502</html>", { status: 502 }))

    await click()

    expect(toggle().getAttribute("aria-checked")).toBe("false")
    expect(container.textContent).toContain("Failed to save the setting.")
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("falls back to a generic error and stays off when the request itself fails", async () => {
    stubFetch(async () => { throw new TypeError("network down") })

    await click()

    expect(toggle().getAttribute("aria-checked")).toBe("false")
    expect(container.textContent).toContain("Failed to save the setting.")
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("is disabled while the save is in flight and enabled again after", async () => {
    let respond!: (res: Response) => void
    stubFetch(() => new Promise<Response>((resolve) => { respond = resolve }))

    await click()
    expect(toggle().disabled).toBe(true)

    await act(async () => respond(Response.json({ ok: true, bankSyncEnabled: true })))
    expect(toggle().disabled).toBe(false)
    expect(toggle().getAttribute("aria-checked")).toBe("true")
  })
})
