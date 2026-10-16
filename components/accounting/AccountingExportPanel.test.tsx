// @vitest-environment jsdom
// The panel loads its preview when the month changes and again after a close.
// What matters here: the right URLs are fetched, a reload after a POST shows
// the new state, and a response for a month the user has left is ignored.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AccountingExportPanel } from "./AccountingExportPanel"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function preview(period: string, closed = false) {
  return {
    period,
    label: `Label ${period}`,
    closed,
    batchId: closed ? "b1" : null,
    entryCount: 7,
    debitCents: 100,
    creditCents: 100,
    accounts: [],
    events: {},
    refusal: null,
    reconciliation: null,
  }
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

async function render(canClose = true) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<AccountingExportPanel initialPeriod="2026-08" canClose={canClose} xeroConnected={false} />)
  })
  return renderer
}

function changeMonth(renderer: ReactTestRenderer, value: string) {
  const input = renderer.root.findByProps({ id: "period" })
  return act(async () => {
    input.props.onChange({ target: { value } })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("AccountingExportPanel loading", () => {
  it("loads the preview and the history for the initial month", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/accounting/preview") ? reply(preview("2026-08")) : reply({ batches: [] })
    )
    vi.stubGlobal("fetch", fetchMock)

    const text = renderedText(await render())

    expect(fetchMock).toHaveBeenCalledWith("/api/accounting/preview?period=2026-08")
    expect(fetchMock).toHaveBeenCalledWith("/api/accounting/periods")
    expect(text).toContain("Nothing to post for Label 2026-08")
  })

  it("refetches the preview when the month changes", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const m = /period=([\d-]+)/.exec(url)
      return m ? reply(preview(m[1])) : reply({ batches: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render()
    await changeMonth(renderer, "2026-09")

    expect(fetchMock).toHaveBeenCalledWith("/api/accounting/preview?period=2026-09")
    expect(renderedText(renderer)).toContain("Nothing to post for Label 2026-09")
  })

  it("shows the server's refusal and drops the preview when it fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/accounting/preview") ? reply({ error: "No such month" }, false, 400) : reply({ batches: [] })
      )
    )
    const text = renderedText(await render())
    expect(text).toContain("No such month")
    expect(text).not.toContain("Journal entries")
  })

  it("ignores a response for a month the user has already left", async () => {
    let releaseAugust: (() => void) | undefined
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("period=2026-08")) {
        await new Promise<void>((resolve) => { releaseAugust = resolve })
        return reply(preview("2026-08"))
      }
      return url.includes("period=2026-09") ? reply(preview("2026-09")) : reply({ batches: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render()
    await changeMonth(renderer, "2026-09")
    await act(async () => {
      releaseAugust?.()
    })

    const text = renderedText(renderer)
    expect(text).toContain("Nothing to post for Label 2026-09")
    expect(text).not.toContain("Label 2026-08")
  })
})

describe("AccountingExportPanel closing a month", () => {
  it("posts the close, then reloads and shows the closed month", async () => {
    let closed = false
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        closed = true
        return reply({})
      }
      return url.startsWith("/api/accounting/preview") ? reply(preview("2026-08", closed)) : reply({ batches: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render()
    expect(renderedText(renderer)).toContain("Open (preview)")
    const button = renderer.root.findAll((n) => n.type === "button" && n.props.children?.[0] === "Close ")[0]
    await act(async () => {
      await button.props.onClick()
    })

    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe("/api/accounting/periods")
    const text = renderedText(renderer)
    expect(text).not.toContain("Open (preview)")
    expect(text).toContain("Download CSV")
    expect(text).toContain("Label 2026-08 closed.")
  })
})
