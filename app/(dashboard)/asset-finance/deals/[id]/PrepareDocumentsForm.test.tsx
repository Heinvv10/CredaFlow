import { act, create } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), sendJson: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/components/asset-finance/register-form-controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/asset-finance/register-form-controls")>()),
  sendJson: mocks.sendJson,
}))

import { PrepareDocumentsForm } from "./PrepareDocumentsForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  mocks.sendJson.mockResolvedValue({ ok: true, body: {} })
})

async function prepare(props: Parameters<typeof PrepareDocumentsForm>[0]) {
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<PrepareDocumentsForm {...props} />) })
  await act(async () => { await renderer.root.findByType("button").props.onClick() })
  return renderer
}

describe("PrepareDocumentsForm", () => {
  it("sends today as the start of an instalment sale, as before", async () => {
    await prepare({ dealId: "deal-1", today: "2030-01-10", latest: "2030-04-10", again: false })
    expect(mocks.sendJson).toHaveBeenCalledWith("/api/asset-finance/deals/deal-1/signing", "POST", { plannedStartDate: "2030-01-10" })
  })

  it("sends the first due date, not today, for a lease with rentals in advance, and offers no date to change", async () => {
    const renderer = await prepare({ dealId: "deal-2", today: "2030-01-10", latest: "2030-04-10", again: false, fixedStart: "2030-02-01" })
    expect(mocks.sendJson).toHaveBeenCalledWith("/api/asset-finance/deals/deal-2/signing", "POST", { plannedStartDate: "2030-02-01" })
    expect(renderer.root.findAllByType("input")).toHaveLength(0)
  })
})
