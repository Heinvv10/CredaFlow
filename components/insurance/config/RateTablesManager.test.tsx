// @vitest-environment jsdom
// The manager loads a product's rate cards and the first card's detail, and
// reloads both after a draft is created. A response for a product the screen
// has moved off must not replace the current one.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RateTableDetailPanel } from "./RateTableDetailPanel"
import { RateTablesManager } from "./RateTablesManager"

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function summary(id: string, productId: string, version: number, name: string) {
  return {
    id, productId, insurerId: null, version, name, status: "DRAFT", basis: "AGE_BANDED",
    effectiveFrom: "2026-08-01T00:00:00.000Z", effectiveTo: null, createdAt: "2026-08-01T00:00:00.000Z",
    _count: { bands: 0 },
  }
}

function detail(id: string, productId: string, version: number, name: string) {
  const { _count: _omit, ...rest } = summary(id, productId, version, name)
  return { ...rest, bands: [] }
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

function element(productId: string) {
  return <RateTablesManager productId={productId} productName="Funeral" canWrite />
}

async function mount(productId = "p1") {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(element(productId)) })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("RateTablesManager", () => {
  it("shows the loading state, then the versions and the first card's detail", async () => {
    let release: (() => void) | undefined
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/insurance/eligibility-rules")) return reply([])
      if (url.startsWith("/api/insurance/rate-tables?")) {
        await new Promise<void>((resolve) => { release = resolve })
        return reply([summary("rt1", "p1", 1, "Card one")])
      }
      return reply(detail("rt1", "p1", 1, "Card one"))
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(renderedText(renderer)).toContain("Loading rate tables")
    await act(async () => { release?.() })

    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/rate-tables?productId=p1")
    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/rate-tables/rt1")
    const text = renderedText(renderer)
    expect(text).toContain("v1")
    expect(text).not.toContain("Loading rate tables")
  })

  it("shows the server's words when the list cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("/api/insurance/rate-tables?") ? reply({ error: "No access." }, false, 403) : reply([])
    ))
    const text = renderedText(await mount())
    expect(text).toContain("No access.")
    expect(text).not.toContain("Loading rate tables")
  })

  it("keeps the list and reports the error when only the detail fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/insurance/eligibility-rules")) return reply([])
      if (url.startsWith("/api/insurance/rate-tables?")) return reply([summary("rt1", "p1", 1, "Card one")])
      return reply({ error: "Detail unavailable." }, false, 500)
    }))
    const text = renderedText(await mount())
    expect(text).toContain("v1")
    expect(text).toContain("Detail unavailable.")
  })

  it("reloads the list after a draft is created and selects the new version", async () => {
    let tables = [summary("rt1", "p1", 1, "Card one")]
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.startsWith("/api/insurance/eligibility-rules")) return reply([])
      if (init?.method === "POST") {
        const created = summary("rt2", "p1", 2, "Funeral rates")
        tables = [created, ...tables]
        return reply(created)
      }
      if (url.startsWith("/api/insurance/rate-tables?")) return reply(tables)
      return reply(detail(url.endsWith("rt2") ? "rt2" : "rt1", "p1", url.endsWith("rt2") ? 2 : 1, "x"))
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    const newDraft = renderer.root.findAllByType("button").find((b) => b.props.children === "+ New draft")
    await act(async () => { await newDraft?.props.onClick() })

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/insurance/rate-tables?"))).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/rate-tables/rt2")
    expect(renderedText(renderer)).toContain("v2")
  })

  it("keeps the card on screen when a reload fails to read its replacement", async () => {
    let tables = [summary("rt1", "p1", 1, "Card one")]
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.startsWith("/api/insurance/eligibility-rules")) return reply([])
      if (init?.method === "POST") {
        const created = summary("rt2", "p1", 2, "Funeral rates")
        tables = [created, ...tables]
        return reply(created)
      }
      if (url.startsWith("/api/insurance/rate-tables?")) return reply(tables)
      if (url.endsWith("rt2")) return reply({ error: "Detail unavailable." }, false, 500)
      return reply(detail("rt1", "p1", 1, "Card one"))
    }))

    const renderer = await mount()
    const newDraft = renderer.root.findAllByType("button").find((b) => b.props.children === "+ New draft")
    await act(async () => { await newDraft?.props.onClick() })

    const text = renderedText(renderer)
    expect(text).toContain("Detail unavailable.")
    expect(renderer.root.findAllByType(RateTableDetailPanel)).toHaveLength(1) // the previous card stays
  })

  it("ignores a response for a product it has moved off", async () => {
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/insurance/eligibility-rules")) return reply([])
      if (url.endsWith("productId=p1")) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return reply([summary("a1", "p1", 7, "Old product card")])
      }
      if (url.endsWith("productId=p2")) return reply([summary("b1", "p2", 9, "New product card")])
      return reply(detail(url.endsWith("b1") ? "b1" : "a1", "p", 1, "x"))
    }))

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(element("p1")) })
    await act(async () => { renderer.update(element("p2")) })
    await act(async () => { releaseFirst?.() })

    const text = renderedText(renderer)
    expect(text).toContain("v9")
    expect(text).not.toContain("v7")
  })
})
