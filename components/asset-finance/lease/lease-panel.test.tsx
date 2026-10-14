import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("@/lib/prisma", () => ({ prisma: { assetValuation: { findMany: vi.fn(async () => []) } } }))

import { renderedText } from "./lease-test-helpers"
import { ClaimActions } from "./ClaimActions"
import { LeaseEndOfTermPanel } from "./LeaseEndOfTermPanel"
import type { EndOfTermView, LeaseStaffData } from "./lease-staff-data"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

const eot = (over: Partial<EndOfTermView>): EndOfTermView => ({
  outcome: "RETURN", status: "ELECTED", origin: "EXPIRY", electedOn: "2030-05-01", extensionNoticeOn: null, extensionEndsOn: null, inspectedOn: null,
  condition: null, finalReading: null, damage: [], purchasePriceExclVatCents: null, excessUsageCents: null, fundSettlementCents: null, invoice: null,
  natisRequired: false, natisConfirmed: false, completedOn: null, ...over,
})
const data = (endOfTerm: EndOfTermView | null, over: Partial<LeaseStaffData> = {}): LeaseStaffData => ({
  loanId: "loan-1", loanStatus: "ACTIVE", contractType: "OPERATING_LEASE", today: "2030-06-15", maturityDate: "2030-09-01", expiryDate: "2030-09-01",
  electionOpensOn: "2030-03-01", assetId: "asset-1",
  deal: { id: "deal-1", rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1", usage: null },
  cpaApplies: false, rentals: [], fund: null, readings: [], usage: null, endOfTerm, expiryNotice: null, quotes: [], purchaseMaxAgeDays: 30, ...over,
})

async function panel(view: LeaseStaffData, canManage: boolean, canDecide: boolean) {
  const element = await LeaseEndOfTermPanel({ tenantId: "t-1", data: view, canManage, canDecide })
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(element) })
  return renderer
}
const text = renderedText
const buttons = (renderer: ReactTestRenderer) => renderer.root.findAllByType("button").map((b) => b.children.join(""))

describe("LeaseEndOfTermPanel", () => {
  it("offers the election, and nothing else, before a choice is made", async () => {
    const renderer = await panel(data(null), true, true)
    expect(buttons(renderer)).toEqual(["Record the choice"])
  })

  it("offers no election before the window opens, and names the date", async () => {
    const renderer = await panel(data(null, { electionOpensOn: "2030-12-01" }), true, true)
    expect(buttons(renderer)).toEqual([])
    expect(text(renderer)).toContain("It opens on")
  })

  it("shows the inspection form after a return is elected, and no invoice button yet", async () => {
    const renderer = await panel(data(eot({})), true, true)
    expect(buttons(renderer)).toContain("Record the inspection")
    expect(buttons(renderer).join()).not.toContain("invoice")
  })

  it("shows the invoice button to a decider after the inspection, and a note instead to a manager", async () => {
    const inspected = data(eot({ status: "INSPECTED", inspectedOn: "2030-06-10", condition: "Good" }))
    expect(buttons(await panel(inspected, true, true))).toEqual(["Issue the end-of-term invoice"])
    const manager = await panel(inspected, true, false)
    expect(buttons(manager)).toEqual([])
    expect(text(manager)).toContain("needs the decide asset finance permission")
  })

  it("asks for the eNaTIS confirmation of a purchased registered vehicle once invoiced", async () => {
    const invoiced = eot({ outcome: "PURCHASE", status: "INVOICED", natisRequired: true, purchasePriceExclVatCents: 5_000_000, invoice: { id: "inv-1", number: "INV-000001" } })
    expect(buttons(await panel(data(invoiced), true, true))).toEqual(["Confirm the eNaTIS change of ownership"])
    expect(buttons(await panel(data({ ...invoiced, natisConfirmed: true }), true, true))).toEqual([])
  })

  it("offers nothing on a completed end of term", async () => {
    expect(buttons(await panel(data(eot({ status: "COMPLETED", completedOn: "2030-07-01" })), true, true))).toEqual([])
  })

  it("links the expiry notice once queued and the inspection report once inspected, and neither before", async () => {
    const links = (renderer: ReactTestRenderer) => renderer.root.findAllByType("a").map((a) => a.props.href)
    const docs = "/api/asset-finance/leases/loan-1/documents"
    expect(links(await panel(data(null), true, true))).toEqual([])
    expect(links(await panel(data(eot({})), true, true))).toEqual([])
    expect(links(await panel(data(null, { expiryNotice: { queuedOn: "2030-04-01" } }), true, true))).toEqual([`${docs}/expiry-notice`])
    const inspected = data(eot({ status: "INSPECTED", inspectedOn: "2030-06-10", condition: "Good" }), { expiryNotice: { queuedOn: "2030-04-01" } })
    const renderer = await panel(inspected, false, false)
    expect(links(renderer)).toEqual([`${docs}/expiry-notice`, `${docs}/inspection-report`])
    expect(text(renderer)).toContain("CPA expiry notice (01 Apr 2030)")
  })
})

describe("a refused step", () => {
  it("shows the route's refusal inline and does not refresh the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "The person who submitted a claim cannot approve it", reason: "same_user" }), { status: 409 })))
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<ClaimActions url="/api/asset-finance/leases/loan-1/claims/c-1" approve reject={false} paid={false} hint={null} />) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toBe("The person who submitted a claim cannot approve it")
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("posts the approval to the claim's route and refreshes on success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ kind: "ok" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(<ClaimActions url="/api/asset-finance/leases/loan-1/claims/c-1" approve reject={false} paid={false} hint={null} />) })
    await act(async () => { await renderer.root.findByType("button").props.onClick() })
    expect(fetchMock).toHaveBeenCalledWith("/api/asset-finance/leases/loan-1/claims/c-1/approve", expect.objectContaining({ method: "POST" }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})
