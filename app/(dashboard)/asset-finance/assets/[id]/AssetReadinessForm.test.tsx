import { act, create } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), sendJson: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/components/asset-finance/register-form-controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/asset-finance/register-form-controls")>()),
  sendJson: mocks.sendJson,
}))

import { AssetReadinessForm } from "./AssetReadinessForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  mocks.sendJson.mockResolvedValue({ ok: true, body: {} })
})

const initial = {
  natisTitleholder: "TEST Titleholder", natisOwner: "TEST Lender (Pty) Ltd", trackerProvider: null, trackerId: null, insurer: null, policyNumber: null, lenderNotedConfirmed: false,
}

describe("AssetReadinessForm", () => {
  it("shows the eNaTIS owner and saves a changed one with the other payout facts", async () => {
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<AssetReadinessForm assetId="asset-1" initial={initial} />) })
    const owner = renderer.root.findAll((n) => n.type === "input" && n.props.id === "natisOwner")[0]
    expect(owner.props.value).toBe("TEST Lender (Pty) Ltd")
    await act(async () => { owner.props.onChange({ target: { value: " TEST Other Lender " } }) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })
    expect(mocks.sendJson).toHaveBeenCalledWith("/api/asset-finance/assets/asset-1", "PATCH", expect.objectContaining({
      natisOwner: "TEST Other Lender", natisTitleholder: "TEST Titleholder",
    }))
  })

  it("clears the owner when the field is emptied", async () => {
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<AssetReadinessForm assetId="asset-1" initial={initial} />) })
    const owner = renderer.root.findAll((n) => n.type === "input" && n.props.id === "natisOwner")[0]
    await act(async () => { owner.props.onChange({ target: { value: "" } }) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })
    expect(mocks.sendJson.mock.calls[0][2]).toMatchObject({ natisOwner: null })
  })
})
