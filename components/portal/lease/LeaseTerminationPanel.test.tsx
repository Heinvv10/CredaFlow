import { act, create, type ReactTestInstance } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PortalLeaseQuote } from "@/lib/asset-finance/portal-lease"
import type { TerminationActions } from "@/lib/asset-finance/portal-lease-view"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), post: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("./lease-action", async (importOriginal) => ({ ...(await importOriginal<typeof import("./lease-action")>()), postLeaseAction: mocks.post }))

import { LeaseTerminationPanel } from "./LeaseTerminationPanel"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
})

const quote: PortalLeaseQuote = {
  id: "q1", quotedOn: "2027-05-10", terminationDate: "2027-06-08", validUntil: "2027-05-20", status: "QUOTED", cpaCancellation: true,
  remainingRentals: 20, pvCents: 1_000_000, penaltyCents: 100_000, arrearsCents: 0, invoiceVatCents: 165_000, totalCents: 1_265_000,
  basis: "Synthetic basis text for the quote.",
}
const valid: TerminationActions = { state: "VALID", canRequest: true, canAccept: true }

async function mount(props: { quote: PortalLeaseQuote | null; actions: TerminationActions }) {
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<LeaseTerminationPanel loanId="L1" {...props} />) })
  return renderer
}
const buttons = (r: ReturnType<typeof create>) => r.root.findAllByType("button")
const labelled = (r: ReturnType<typeof create>, text: string): ReactTestInstance | undefined =>
  buttons(r).find((b) => b.children.join("") === text)
type Json = ReturnType<ReturnType<typeof create>["toJSON"]>
const flatten = (node: Json | string | null | undefined): string => {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(flatten).join("")
  return (node.children ?? []).map(flatten).join("")
}
const text = (r: ReturnType<typeof create>) => flatten(r.toJSON())

describe("LeaseTerminationPanel", () => {
  it("offers only a quote request before any quote", async () => {
    const r = await mount({ quote: null, actions: { state: "NONE", canRequest: true, canAccept: false } })
    expect(buttons(r).map((b) => b.children.join(""))).toEqual(["Request a quote"])
  })

  it("shows the quote figures and its basis, and offers accept while valid", async () => {
    const r = await mount({ quote, actions: valid })
    const out = text(r)
    expect(out).toContain("Present value of those rentals")
    expect(out).toContain("12,650.00")
    expect(out).toContain("Synthetic basis text for the quote.")
    expect(buttons(r).map((b) => b.children.join(""))).toEqual(["Accept this quote", "Request a new quote"])
  })

  it("withdraws accept when the quote has expired", async () => {
    const r = await mount({ quote, actions: { state: "EXPIRED", canRequest: true, canAccept: false } })
    expect(labelled(r, "Accept this quote")).toBeUndefined()
    expect(text(r)).toContain("Expired")
    expect(labelled(r, "Request a new quote")).toBeDefined()
  })

  it("offers nothing once accepted", async () => {
    const r = await mount({ quote: { ...quote, status: "ACCEPTED" }, actions: { state: "ACCEPTED", canRequest: false, canAccept: false } })
    expect(buttons(r)).toHaveLength(0)
    expect(text(r)).toContain("Accepted")
  })

  it("asks for confirmation before accepting, then posts to the accept route", async () => {
    mocks.post.mockResolvedValue({ ok: true, body: {} })
    const r = await mount({ quote, actions: valid })
    await act(async () => { labelled(r, "Accept this quote")?.props.onClick() })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(text(r)).toContain("Accepting cannot be undone.")
    await act(async () => { await labelled(r, "Yes, end the lease early")?.props.onClick() })
    expect(mocks.post).toHaveBeenCalledWith("/api/portal/asset-finance/leases/L1/termination-quotes/q1/accept", {}, expect.any(String))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it("going back from the confirm step posts nothing", async () => {
    const r = await mount({ quote, actions: valid })
    await act(async () => { labelled(r, "Accept this quote")?.props.onClick() })
    await act(async () => { labelled(r, "Go back")?.props.onClick() })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(labelled(r, "Accept this quote")).toBeDefined()
  })

  it("shows the refusal message and does not refresh", async () => {
    mocks.post.mockResolvedValue({ ok: false, message: "The quote expired on 2027-05-20" })
    const r = await mount({ quote: null, actions: { state: "NONE", canRequest: true, canAccept: false } })
    await act(async () => { await labelled(r, "Request a quote")?.props.onClick() })
    expect(mocks.post).toHaveBeenCalledWith("/api/portal/asset-finance/leases/L1/termination-quotes", {}, expect.any(String))
    expect(r.root.findByProps({ role: "alert" }).children.join("")).toBe("The quote expired on 2027-05-20")
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it("links the quote's PDF whenever there is a quote, and nothing before one", async () => {
    const links = (r: ReturnType<typeof create>) => r.root.findAllByType("a").map((a) => a.props.href)
    expect(links(await mount({ quote, actions: valid }))).toEqual(["/api/portal/asset-finance/leases/L1/documents/termination-quote?quoteId=q1&download=1"])
    expect(links(await mount({ quote: { ...quote, status: "ACCEPTED" }, actions: { state: "ACCEPTED", canRequest: false, canAccept: false } }))).toHaveLength(1)
    expect(links(await mount({ quote: null, actions: { state: "NONE", canRequest: true, canAccept: false } }))).toEqual([])
  })
})
