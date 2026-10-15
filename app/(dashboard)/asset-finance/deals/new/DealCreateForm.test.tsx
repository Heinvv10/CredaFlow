import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { DealCreateForm } from "./DealCreateForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const options = {
  entities: [{ id: "e-1", label: "TEST Entity (Pty) Ltd" }], clients: [{ id: "c-1", label: "Synthetic Sole · C-1" }],
  assets: [{ id: "a-1", label: "2024 TEST Loader" }], suppliers: [{ id: "s-1", label: "TEST Supplier" }], products: [{ id: "p-1", label: "TEST Product" }],
}
const lease = {
  startDate: "2030-02-01", termDays: 1800, rate: { annualRate: "0.125" }, financedAmountCents: 100_000_00, baseInstalmentCents: 2_000_00, rows: [], totalInterestCents: 0, totalPayableCents: 0,
  lease: {
    vatRate: "0.1500", baseRentalCents: 2_000_00, totalRentalExclVatCents: 24_000_00, totalMaintenanceExclVatCents: 0, totalVatCents: 3_600_00, totalCents: 27_600_00,
    rows: [{ periodNo: 1, dueDate: "2030-02-01", rentalExclVatCents: 2_000_00, maintenanceExclVatCents: 0, vatCents: 300_00, totalCents: 2_300_00 }],
  },
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  fetchMock = vi.fn(async () => new Response(JSON.stringify(lease), { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const find = (renderer: ReactTestRenderer, type: "input" | "select", id: string) =>
  renderer.root.findAll((node) => node.type === type && node.props.id === id)[0]
const change = (renderer: ReactTestRenderer, type: "input" | "select", id: string, value: string) =>
  act(async () => { find(renderer, type, id).props.onChange({ target: { value } }) })
const previewBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>)

async function fillCommon(renderer: ReactTestRenderer) {
  await change(renderer, "select", "assetId", "a-1")
  await change(renderer, "input", "firstDueDate", "2030-02-01")
  await change(renderer, "input", "ratePercent", "12.5")
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(500) })

describe("DealCreateForm", () => {
  it("previews an instalment sale with its own body: deposit, trade-in and no lease terms", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<DealCreateForm options={options} />) })
    await fillCommon(renderer)
    await change(renderer, "input", "deposit", "5000")
    await settle()
    expect(previewBodies()).toHaveLength(1)
    expect(previewBodies()[0]).toMatchObject({ contractType: "INSTALMENT_SALE", depositCents: 500_000, nca: false })
    expect(previewBodies()[0]).not.toHaveProperty("rentalTiming")
    expect(find(renderer, "input", "deposit")).toBeDefined()
  })

  it("previews an operating lease with lease terms, no deposit, trade-in or fee fields, and the lease preview", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<DealCreateForm options={options} />) })
    await change(renderer, "select", "contractType", "OPERATING_LEASE")
    await fillCommon(renderer)
    await change(renderer, "input", "penaltyPercent", "10")
    await change(renderer, "input", "escalationPercent", "8")
    await change(renderer, "select", "rentalTiming", "ADVANCE")
    await settle()
    const [body] = previewBodies()
    expect(body).toMatchObject({
      contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1", nca: false, preset: { kind: "MONTHLY", periods: 60 },
    })
    for (const key of ["depositCents", "tradeInCents", "financedFeesCents"]) expect(body).not.toHaveProperty(key)
    for (const id of ["deposit", "tradeIn", "fees"]) expect(find(renderer, "input", id)).toBeUndefined()
    expect(JSON.stringify(renderer.toJSON())).toContain("By lease year")
  })

  it("asks for the maintenance and usage fields only on a full-maintenance lease", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<DealCreateForm options={options} />) })
    await change(renderer, "select", "contractType", "OPERATING_LEASE")
    expect(find(renderer, "input", "maintenanceRands")).toBeUndefined()
    await change(renderer, "select", "contractType", "FULL_MAINTENANCE_LEASE")
    expect(find(renderer, "input", "maintenanceRands")).toBeDefined()
    expect(find(renderer, "select", "riskModel")).toBeDefined()
    await change(renderer, "select", "contractType", "INSTALMENT_SALE")
    expect(find(renderer, "input", "maintenanceRands")).toBeUndefined()
    expect(find(renderer, "input", "deposit")).toBeDefined()
  })
})
