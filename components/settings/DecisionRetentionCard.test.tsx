// @vitest-environment jsdom
// The card refuses a period under the 60-month floor before asking the server,
// says why, and shows the server's own message when the server refuses.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DecisionRetentionCard } from "./DecisionRetentionCard"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

function text(renderer: ReactTestRenderer): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === "object" && "children" in node) walk((node as { children: unknown }).children)
  }
  walk(renderer.toJSON())
  return out.join(" ")
}

const input = (r: ReactTestRenderer) => r.root.find((n) => n.type === "input" && n.props.id === "decisionRetentionMonths")
const saveButton = (r: ReactTestRenderer) => r.root.find((n) => n.type === "button" && text({ toJSON: () => n.props.children } as never).includes("Save retention setting"))

async function render(months: number | null) {
  let r!: ReactTestRenderer
  await act(async () => { r = create(<DecisionRetentionCard months={months} canChange />) })
  return r
}

async function type(r: ReactTestRenderer, value: string) {
  await act(async () => { input(r).props.onChange({ target: { value } }) })
}

afterEach(() => vi.unstubAllGlobals())

describe("DecisionRetentionCard", () => {
  it("labels and bounds the field 60 to 600", async () => {
    const r = await render(72)
    expect(text(r)).toContain("60 to 600")
    expect(input(r).props).toMatchObject({ min: 60, max: 600 })
  })

  it("refuses 59 without calling the server and says the floor", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const r = await render(72)
    await type(r, "59")
    expect(saveButton(r).props.disabled).toBe(true)
    expect(text(r)).toContain("at least 60 months")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("accepts 60", async () => {
    const r = await render(72)
    await type(r, "60")
    expect(saveButton(r).props.disabled).toBe(false)
    expect(text(r)).not.toContain("at least 60 months")
  })

  it("shows the server's message when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "months must be a whole number from 60 to 600." }) }))
    const r = await render(72)
    await type(r, "61")
    await act(async () => { await saveButton(r).props.onClick() })
    expect(text(r)).toContain("months must be a whole number from 60 to 600.")
  })
})
