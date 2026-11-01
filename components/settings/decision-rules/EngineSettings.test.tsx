// @vitest-environment jsdom
import { act, create } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EngineSettings } from "./EngineSettings"
import type { Overview } from "./types"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { vi.unstubAllGlobals(); delete actEnvironment.IS_REACT_ACT_ENVIRONMENT })

const overview = (keyFactsInstance: boolean) => ({
  facts: [], products: [], versions: [], requests: [], canManage: true, canApprove: false, keyFactsInstance,
  config: { mode: "LIVE", channels: ["PORTAL"], productIds: [], repaymentMethod: "EFT", challengerVersionId: null, challengerPercent: 0, s71SignOff: false, automatedDeclineNotice: null, keyFactsInstantApproval: false },
  stats: { sinceDays: 30, total: 0, byExecution: {}, byVerdict: {}, byRole: {}, latencyMs: null, submissionLatencyMs: null },
}) as unknown as Overview

async function mount(keyFactsInstance: boolean) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<EngineSettings overview={overview(keyFactsInstance)} onDone={() => undefined} />) })
  return renderer
}

describe("EngineSettings: instant approval of digital applications", () => {
  it("is not offered at all on an instance under the NCA", async () => {
    expect(JSON.stringify((await mount(false)).toJSON())).not.toContain("Instant approval")
  })

  it("is offered, off, on a key-facts instance, and goes to the second person with the rest of the settings", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ request: { id: "cr-1" } }) }))
    vi.stubGlobal("fetch", fetchMock)
    const r = await mount(true)
    expect(JSON.stringify(r.toJSON())).toContain("Instant approval of digital applications")
    const boxes = () => r.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")
    const box = boxes().at(-1)!
    expect(box.props.checked).toBe(false)
    await act(async () => { box.props.onChange() })
    expect(boxes().at(-1)!.props.checked).toBe(true)
    await act(async () => { await r.root.findAll((n) => n.type === "button" && n.children.join("") === "Submit for approval")[0].props.onClick() })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ kind: "DECISION_ENGINE_CONFIG", payload: { keyFactsInstantApproval: true } })
  })
})
