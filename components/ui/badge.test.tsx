// @vitest-environment jsdom
// Badges sit inside <p> text (the client page's compliance status, the comms
// agent roster). A div there is invalid HTML, and React reports it as a
// hydration error, so Badge is a span.
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Badge } from "./badge"

const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

afterEach(() => { document.body.innerHTML = "" })

describe("Badge", () => {
  it("can sit inside a paragraph without invalid nesting", async () => {
    g.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.appendChild(container)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await act(async () => { createRoot(container).render(<p>Status <Badge className="x">PENDING</Badge></p>) })
    const nesting = consoleError.mock.calls.some((args) => /cannot be a descendant|cannot contain a nested/.test(String(args[0])))
    consoleError.mockRestore()

    expect(nesting).toBe(false)
    const badge = container.querySelector("p > *")
    expect(badge?.tagName).toBe("SPAN")
    expect(badge?.className).toContain("inline-flex")
    expect(badge?.className).toContain("x")
  })
})
