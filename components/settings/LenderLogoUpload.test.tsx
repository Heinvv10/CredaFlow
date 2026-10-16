// @vitest-environment jsdom
// The logo state is read on mount and again after an upload or removal.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LenderLogoUpload } from "./LenderLogoUpload"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const LOGO_URL = "/api/settings/identity/logo"

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

const logoImages = (renderer: ReactTestRenderer) => renderer.root.findAllByType("img")

async function mount() {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<LenderLogoUpload />) })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("LenderLogoUpload", () => {
  it("shows the stored logo, with a cache-busting version, when one exists", async () => {
    const fetchMock = vi.fn(async () => reply({}))
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()

    expect(fetchMock).toHaveBeenCalledWith(LOGO_URL, { method: "GET", cache: "no-store" })
    expect(logoImages(renderer)).toHaveLength(1)
    expect(logoImages(renderer)[0].props.src).toMatch(new RegExp(`^${LOGO_URL}\\?v=\\d+$`))
  })

  it("says there is no logo when the route answers not-OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, false, 404)))
    const renderer = await mount()
    expect(logoImages(renderer)).toHaveLength(0)
    expect(renderedText(renderer)).toContain("No logo uploaded.")
  })

  it("reports a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    expect(renderedText(await mount())).toContain("Failed to load the logo.")
  })

  it("re-reads the logo after an upload and shows it", async () => {
    let uploaded = false
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        uploaded = true
        return reply({ changed: true })
      }
      return uploaded ? reply({}) : reply({}, false, 404)
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(logoImages(renderer)).toHaveLength(0)
    const picker = renderer.root.findByProps({ id: "lender-logo" })
    await act(async () => { picker.props.onChange({ target: { files: [new File(["x"], "logo.png", { type: "image/png" })] } }) })
    const upload = renderer.root.findAllByType("button").find((b) => b.props.children === "Upload logo")
    await act(async () => { await upload?.props.onClick() })

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    expect(logoImages(renderer)).toHaveLength(1)
    expect(renderedText(renderer)).toContain("Logo saved.")
  })
})
