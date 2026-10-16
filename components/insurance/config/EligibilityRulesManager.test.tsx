// @vitest-environment jsdom
// Rules load when the product is set and again after every write. A response
// for a product the screen has moved off must not replace the current list.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EligibilityRulesManager } from "./EligibilityRulesManager"

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function rule(id: string, productId: string, ruleType: string, numericValue: string) {
  return { id, productId, lifeScope: "ALL_LIVES", ruleType, numericValue, textValue: null, active: true }
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

async function mount(productId = "p1") {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<EligibilityRulesManager productId={productId} canWrite />)
  })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("EligibilityRulesManager", () => {
  it("shows the loading state, then the product's rules", async () => {
    let release: (() => void) | undefined
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return reply([rule("r1", "p1", "MIN_ENTRY_AGE", "18")])
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    expect(renderedText(renderer)).toContain("Loading eligibility rules")
    await act(async () => { release?.() })

    expect(fetchMock).toHaveBeenCalledWith("/api/insurance/eligibility-rules?productId=p1")
    expect(renderedText(renderer)).toContain("18 years")
    expect(renderedText(renderer)).not.toContain("Loading eligibility rules")
  })

  it("shows the server's words when the rules cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "Not allowed here." }, false, 403)))
    const text = renderedText(await mount())
    expect(text).toContain("Not allowed here.")
    expect(text).not.toContain("Loading eligibility rules")
  })

  it("reloads after a rule is added and shows the new rule", async () => {
    let rules = [rule("r1", "p1", "MIN_ENTRY_AGE", "18")]
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        rules = [...rules, rule("r2", "p1", "MAX_ENTRY_AGE", "65")]
        return reply({})
      }
      return reply(rules)
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await mount()
    const add = renderer.root.findAllByType("button").find((b) => b.props.children === "Add rule")
    await act(async () => { await add?.props.onClick() })

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(2)
    expect(renderedText(renderer)).toContain("65 years")
  })

  it("ignores a response for a product it has moved off", async () => {
    let releaseFirst: (() => void) | undefined
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("productId=p1")) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return reply([rule("r1", "p1", "MIN_ENTRY_AGE", "11")])
      }
      return reply([rule("r2", "p2", "MIN_ENTRY_AGE", "22")])
    }))

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<EligibilityRulesManager productId="p1" canWrite />) })
    await act(async () => { renderer.update(<EligibilityRulesManager productId="p2" canWrite />) })
    await act(async () => { releaseFirst?.() })

    const text = renderedText(renderer)
    expect(text).toContain("22 years")
    expect(text).not.toContain("11 years")
  })
})
