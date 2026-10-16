// @vitest-environment jsdom
// Disclosures load on mount and again after one is logged; a response for a
// client the section has moved off is ignored.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FaisDisclosuresSection } from "./FaisDisclosuresSection"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function record(id: string, who: string) {
  return { id, completedAt: null, createdAt: "2026-09-01T10:00:00.000Z", data: { loggedByName: who, notes: `note ${who}` } }
}

function reply(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body }
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

async function render(clientId = "c1") {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<FaisDisclosuresSection clientId={clientId} />)
  })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("FaisDisclosuresSection", () => {
  it("shows Loading, then the records for the client", async () => {
    let release: (() => void) | undefined
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return reply([record("r1", "Ayanda")])
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render()
    expect(renderedText(renderer)).toContain("Loading...")
    await act(async () => { release?.() })

    expect(fetchMock).toHaveBeenCalledWith("/api/clients/c1/fais-disclosures")
    expect(renderedText(renderer)).toContain("Ayanda")
    expect(renderedText(renderer)).not.toContain("Loading...")
  })

  it("says so when the list cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, false)))
    const text = renderedText(await render())
    expect(text).toContain("Failed to load FAIS disclosures.")
    expect(text).not.toContain("Loading...")
  })

  it("refetches after a disclosure is logged and shows the new row", async () => {
    let rows = [record("r1", "Ayanda")]
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        rows = [...rows, record("r2", "Bongani")]
        return reply({})
      }
      return reply(rows)
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render()
    await act(async () => {
      renderer.root.findAllByType("button")[0].props.onClick() // the header "Log Disclosure" button
    })
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({ preventDefault: () => undefined })
    })

    const gets = fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")
    expect(gets).toHaveLength(2)
    expect(renderedText(renderer)).toContain("Bongani")
  })

  it("ignores a response for a client it has moved off", async () => {
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/c1/")) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return reply([record("r1", "FirstClient")])
      }
      return reply([record("r2", "SecondClient")])
    }))

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<FaisDisclosuresSection clientId="c1" />) })
    await act(async () => { renderer.update(<FaisDisclosuresSection clientId="c2" />) })
    await act(async () => { releaseFirst?.() })

    const text = renderedText(renderer)
    expect(text).toContain("SecondClient")
    expect(text).not.toContain("FirstClient")
  })
})
