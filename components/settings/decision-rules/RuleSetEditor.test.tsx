// @vitest-environment jsdom
// Saving twice edits the one draft the first save created; a submitted request cannot be saved again.
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FACT_DEFINITIONS, FACT_NAMES } from "@/lib/decisioning/facts"
import { RuleSetEditor } from "./RuleSetEditor"
import type { Overview, RuleSetPayload } from "./types"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { vi.unstubAllGlobals(); delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

const overview = {
  facts: FACT_NAMES.map((name) => ({ name, ...FACT_DEFINITIONS[name] })), products: [], versions: [], requests: [], canManage: true, canApprove: false,
  config: { mode: "OFF", channels: [], productIds: [], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: false, automatedDeclineNotice: null },
  stats: { sinceDays: 30, total: 0, byExecution: {}, byVerdict: {}, byRole: {}, latencyMs: null, submissionLatencyMs: null },
} as unknown as Overview
const initial: RuleSetPayload = {
  productId: null, name: "Baseline", effectiveFrom: "2026-11-01", challengerOnly: false, scorecard: null,
  rules: [{ id: "r1", name: "R1", outcome: "REFER", reasonCode: "R_ONE", when: { all: [{ field: "bureauScore", op: "lt", value: 500 }] } }],
}

function reply(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

async function mount() {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<RuleSetEditor overview={overview} initial={initial} onDone={() => undefined} onCancel={() => undefined} />) })
  return renderer
}
const button = (r: ReturnType<typeof create>, text: string) => r.root.findAll((n) => n.type === "button" && n.children.join("") === text)[0]

describe("RuleSetEditor", () => {
  it("a second save edits the draft the first one created, never drafting a duplicate", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => reply({ request: { id: "cr-1" } }))
    vi.stubGlobal("fetch", fetchMock)
    const r = await mount()
    await act(async () => { await button(r, "Save draft").props.onClick() })
    await act(async () => { await button(r, "Save draft").props.onClick() })
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual(["POST /api/maker-checker", "PATCH /api/maker-checker/cr-1"])
  })

  it("submitting uses the draft it saved, then locks the form so a submitted request is not saved over", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => reply({ request: { id: "cr-9" } }))
    vi.stubGlobal("fetch", fetchMock)
    const r = await mount()
    await act(async () => { await button(r, "Submit for approval").props.onClick() })
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual(["POST /api/maker-checker", "POST /api/maker-checker/cr-9/submit"])
    expect(button(r, "Submit for approval").props.disabled).toBe(true)
    expect(button(r, "Save draft").props.disabled).toBe(true)
  })

  it("shows every problem the server found and keeps the form open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ error: "bad", problems: ["rules[0].reasonCode: x", "payload.effectiveFrom: y"] }) })))
    const r = await mount()
    await act(async () => { await button(r, "Save draft").props.onClick() })
    const text = JSON.stringify(r.toJSON())
    expect(text).toContain("rules[0].reasonCode: x")
    expect(text).toContain("payload.effectiveFrom: y")
  })
})
