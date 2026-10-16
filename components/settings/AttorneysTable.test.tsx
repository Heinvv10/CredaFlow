// @vitest-environment jsdom
// The register loads on mount, reloads (with the skeleton) when "Show inactive"
// flips and after every write, and ignores a response for a filter the user
// has already left.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AttorneysTable } from "./AttorneysTable"

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function firm(id: string, name: string, active = true) {
  return { id, name, contactPerson: null, phone: null, email: null, address: null, specialisation: null, active, createdAt: "2026-01-01T00:00:00.000Z" }
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

const isSkeleton = (renderer: ReactTestRenderer) => renderer.root.findAll((n) => n.type === "div" && String(n.props.className).includes("animate-pulse")).length > 0

async function mount() {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<AttorneysTable />) })
  return renderer
}

function toggleInactive(renderer: ReactTestRenderer, checked: boolean) {
  const box = renderer.root.findAllByType("input").find((i) => i.props.type === "checkbox")
  if (!box) throw new Error("no Show inactive checkbox")
  return act(async () => { box.props.onChange({ target: { checked } }) })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AttorneysTable", () => {
  it("shows the skeleton, then the firms", async () => {
    let release: (() => void) | undefined
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return reply([firm("f1", "Alpha Attorneys")])
    }))

    const renderer = await mount()
    expect(isSkeleton(renderer)).toBe(true)
    await act(async () => { release?.() })

    expect(isSkeleton(renderer)).toBe(false)
    expect(renderedText(renderer)).toContain("Alpha Attorneys")
  })

  it("says so when the register cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, false, 500)))
    const text = renderedText(await mount())
    expect(text).toContain("Failed to load attorney firms.")
    expect(text).toContain("No attorney firms found")
  })

  it("refetches with the skeleton when Show inactive is toggled", async () => {
    let release: (() => void) | undefined
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("includeInactive=true")) {
        await new Promise<void>((resolve) => { release = resolve })
        return reply([firm("f1", "Alpha Attorneys"), firm("f2", "Dormant Attorneys", false)])
      }
      return reply([firm("f1", "Alpha Attorneys")])
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    await toggleInactive(renderer, true)
    expect(isSkeleton(renderer)).toBe(true)
    await act(async () => { release?.() })

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/attorneys?includeInactive=true", { credentials: "include" })
    expect(renderedText(renderer)).toContain("Dormant Attorneys")
  })

  it("reloads after a firm is removed", async () => {
    let firms = [firm("f1", "Alpha Attorneys"), firm("f2", "Beta Attorneys")]
    vi.stubGlobal("confirm", vi.fn(() => true))
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") {
        firms = firms.filter((f) => f.id !== "f2")
        return reply({ deleted: true })
      }
      return reply(firms)
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(renderedText(renderer)).toContain("Beta Attorneys")
    const remove = renderer.root.findAllByType("button").filter((b) => b.props.title === "Remove")[1]
    await act(async () => { await remove.props.onClick() })

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "DELETE")).toHaveLength(2)
    expect(renderedText(renderer)).not.toContain("Beta Attorneys")
  })

  it("ignores a response for a filter the user has left", async () => {
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("includeInactive=false")) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return reply([firm("f1", "Active Only Attorneys")])
      }
      return reply([firm("f1", "Active Only Attorneys"), firm("f2", "Everyone Attorneys")])
    }))

    const renderer = await mount()
    await toggleInactive(renderer, true)
    await act(async () => { releaseFirst?.() })

    expect(renderedText(renderer)).toContain("Everyone Attorneys")
  })
})
