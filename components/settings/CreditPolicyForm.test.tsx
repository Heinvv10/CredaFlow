// @vitest-environment jsdom
// The form loads the current policy once on mount and shows "Loading" until
// that settles; a failed load is reported in words.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CreditPolicyForm } from "./CreditPolicyForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function reply(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

function renderedText(renderer: ReactTestRenderer): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === "object" && "children" in node) walk((node as { children: unknown }).children)
  }
  walk(renderer.toJSON())
  return out.join(" ").replace(/\s+/g, " ")
}

async function mount() {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<CreditPolicyForm />) })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("CreditPolicyForm", () => {
  it("shows Loading, then the stored policy in the fields", async () => {
    let release: (() => void) | undefined
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return reply({ bureauMinScore: 620, bureauBlockAdverse: true, ndiBufferPct: 150 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(renderedText(renderer)).toContain("Loading current policy")
    await act(async () => { release?.() })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/credit-policy")
    expect(renderedText(renderer)).not.toContain("Loading current policy")
    expect(renderer.root.findByProps({ id: "bureauMinScore" }).props.value).toBe("620")
    expect(renderer.root.findByProps({ id: "ndiBufferPct" }).props.value).toBe("150")
  })

  it("reports a failed load and leaves the fields empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, false, 500)))
    const renderer = await mount()
    expect(renderedText(renderer)).not.toContain("Loading current policy")
    expect(renderedText(renderer)).toContain("Failed to load the current policy.")
    expect(renderer.root.findByProps({ id: "bureauMinScore" }).props.value).toBe("")
  })

  it("reports a network failure the same way", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    const renderer = await mount()
    expect(renderedText(renderer)).not.toContain("Loading current policy")
    expect(renderedText(renderer)).toContain("Failed to load the current policy.")
  })
})
