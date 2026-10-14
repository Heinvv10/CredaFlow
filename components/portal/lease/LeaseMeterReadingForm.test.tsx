import { act, create } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { LeaseMeterReadingForm } from "./LeaseMeterReadingForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const fetchMock = vi.fn()
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.stubGlobal("fetch", fetchMock)
})

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

async function mount() {
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(<LeaseMeterReadingForm loanId="L1" today="2027-05-10" unit="KM" latest={{ readingDate: "2027-04-10", value: 12_000 }} />)
  })
  return renderer
}
const type = (r: ReturnType<typeof create>, value: string) => act(async () => { r.root.findByType("input").props.onChange({ target: { value } }) })
const submit = (r: ReturnType<typeof create>) => r.root.findByType("button")

describe("LeaseMeterReadingForm", () => {
  it("cannot submit until the reading is a whole number", async () => {
    const r = await mount()
    expect(submit(r).props.disabled).toBe(true)
    await type(r, "12.5")
    expect(submit(r).props.disabled).toBe(true)
    await type(r, "12500")
    expect(submit(r).props.disabled).toBe(false)
  })

  it("posts today's reading to the readings route and refreshes", async () => {
    fetchMock.mockResolvedValue(reply(200, { kind: "recorded", readingId: "r1" }))
    const r = await mount()
    await type(r, "12500")
    await act(async () => { await submit(r).props.onClick() })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/portal/asset-finance/leases/L1/readings")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ readingDate: "2027-05-10", value: 12_500 })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows the refusal message from a 4xx { error, reason } and does not refresh", async () => {
    fetchMock.mockResolvedValue(reply(409, { error: "The reading may not be below an earlier one (12000)", reason: "not_monotonic" }))
    const r = await mount()
    await type(r, "100")
    await act(async () => { await submit(r).props.onClick() })
    expect(r.root.findByProps({ role: "status" }).children.join("")).toBe("The reading may not be below an earlier one (12000)")
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
