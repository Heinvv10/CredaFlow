import { act, create } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), sendJson: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/components/asset-finance/register-form-controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/asset-finance/register-form-controls")>()),
  sendJson: mocks.sendJson,
}))

import { BureauChecksButton } from "./BureauChecksButton"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
})

describe("BureauChecksButton", () => {
  it("shows people whose concurrent bureau check is still busy", async () => {
    mocks.sendJson.mockResolvedValue({
      ok: true,
      body: {
        results: [
          { clientId: "c-1", role: "DIRECTOR", outcome: "stored" },
          { clientId: "c-2", role: "TRUSTEE", outcome: "busy" },
        ],
      },
    })
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<BureauChecksButton dealId="deal-1" />) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })

    expect(renderer.root.findByProps({ role: "status" }).children.join("")).toContain("1 bureau check is still busy")
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})
