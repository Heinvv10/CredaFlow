// @vitest-environment jsdom
// The identity loads on mount and is re-read after a save, which also clears
// the typed-twice confirmations.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LenderIdentityForm } from "./LenderIdentityForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function identity(legalName: string) {
  return { legalName, brandName: "Trading Name", ncrNumber: "NCRCP0000", fscaNumber: null }
}

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
  await act(async () => { renderer = create(<LenderIdentityForm />) })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("LenderIdentityForm", () => {
  it("shows Loading, then the stored identity, null fields as empty strings", async () => {
    let release: (() => void) | undefined
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return reply({ identity: identity("Example Lending (Pty) Ltd") })
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(renderedText(renderer)).toContain("Loading lender identity")
    await act(async () => { release?.() })

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/identity")
    expect(renderer.root.findByProps({ id: "legalName" }).props.value).toBe("Example Lending (Pty) Ltd")
    expect(renderer.root.findByProps({ id: "fscaNumber" }).props.value).toBe("")
  })

  it("reports a failed load instead of showing an empty form as if it were stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, false, 500)))
    const text = renderedText(await mount())
    expect(text).toContain("Failed to load the lender identity.")
    expect(text).not.toContain("Loading lender identity")
  })

  it("re-reads the identity after a save and shows what the server stored", async () => {
    let stored = "Before (Pty) Ltd"
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "PUT") {
        stored = "After (Pty) Ltd"
        return reply({ changed: true })
      }
      return reply({ identity: identity(stored) })
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    const save = renderer.root.findAllByType("button").find((b) => b.props.children === "Save lender identity")
    await act(async () => { await save?.props.onClick() })

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "PUT")).toHaveLength(2)
    expect(renderer.root.findByProps({ id: "legalName" }).props.value).toBe("After (Pty) Ltd")
    expect(renderedText(renderer)).toContain("Lender identity saved.")
  })
})
