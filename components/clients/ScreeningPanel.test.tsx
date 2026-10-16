// @vitest-environment jsdom
// The panel loads one party's screening on mount, again after "Screen now",
// and ignores a response for an endpoint it has moved off.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScreeningPanel } from "./ScreeningPanel"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function screening(state: string, message: string) {
  return { state: { state }, message, runAt: null, checks: [] }
}

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
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

async function mount(endpoint: string) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<ScreeningPanel endpoint={endpoint} />)
  })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ScreeningPanel", () => {
  it("loads the screening result from its endpoint", async () => {
    const fetchMock = vi.fn(async () => reply(screening("CLEAR", "No matches found.")))
    vi.stubGlobal("fetch", fetchMock)

    const text = renderedText(await mount("/api/clients/c1/screening"))

    expect(fetchMock).toHaveBeenCalledWith("/api/clients/c1/screening")
    expect(text).toContain("CLEAR")
    expect(text).toContain("No matches found.")
  })

  it("says the role cannot view results on a 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, 403)))
    expect(renderedText(await mount("/x"))).toContain("Your role cannot view screening results.")
  })

  it("says the results could not be loaded on any other failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, 500)))
    expect(renderedText(await mount("/x"))).toContain("Screening results could not be loaded.")
  })

  it("posts 'Screen now' and then shows the refreshed result", async () => {
    let screened = false
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        screened = true
        return reply({})
      }
      return reply(screened ? screening("REFER", "Possible match.") : screening("NOT_SCREENED", "Not screened yet."))
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount("/x")
    expect(renderedText(renderer)).toContain("Not screened yet.")
    await act(async () => {
      await renderer.root.findAllByType("button")[0].props.onClick()
    })

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    expect(renderedText(renderer)).toContain("Possible match.")
  })

  it("ignores a response for an endpoint it has moved off", async () => {
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/first") {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return reply(screening("CLEAR", "From the first endpoint."))
      }
      return reply(screening("BLOCKED", "From the second endpoint."))
    }))

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<ScreeningPanel endpoint="/first" />) })
    await act(async () => { renderer.update(<ScreeningPanel endpoint="/second" />) })
    await act(async () => { releaseFirst?.() })

    const text = renderedText(renderer)
    expect(text).toContain("From the second endpoint.")
    expect(text).not.toContain("From the first endpoint.")
  })
})
