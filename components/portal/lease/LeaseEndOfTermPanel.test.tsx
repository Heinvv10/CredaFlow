import { act, create } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EndOfTermOffer } from "@/lib/asset-finance/portal-lease-view"

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), post: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock("./lease-action", async (importOriginal) => ({ ...(await importOriginal<typeof import("./lease-action")>()), postLeaseAction: mocks.post }))

import { LeaseEndOfTermPanel } from "./LeaseEndOfTermPanel"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
})

const valuation = { valuedOn: "2027-09-01", amountExclVatCents: 40_000_000 }
const open = (options: Array<"RETURN" | "EXTEND" | "PURCHASE">): EndOfTermOffer => ({ kind: "open", options })

async function mount(offer: EndOfTermOffer, chosen: Parameters<typeof LeaseEndOfTermPanel>[0]["chosen"] = null) {
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<LeaseEndOfTermPanel loanId="L1" offer={offer} chosen={chosen} valuation={valuation} />) })
  return renderer
}
type Json = ReturnType<ReturnType<typeof create>["toJSON"]>
const flatten = (node: Json | string | null | undefined): string => {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(flatten).join("")
  return (node.children ?? []).map(flatten).join("")
}
const text = (r: ReturnType<typeof create>) => flatten(r.toJSON())
const optionButtons = (r: ReturnType<typeof create>) => r.root.findAllByType("button").filter((b) => b.props["aria-pressed"] !== undefined)
const optionLabels = (r: ReturnType<typeof create>) => optionButtons(r).map((b) => b.findAllByType("span")[0].children.join(""))

describe("LeaseEndOfTermPanel", () => {
  it("says when the choice opens and offers no button before then", async () => {
    const r = await mount({ kind: "not_open", opensOn: "2027-06-30" })
    expect(text(r)).toContain("from 30 Jun 2027.")
    expect(r.root.findAllByType("button")).toHaveLength(0)
  })

  it("offers return and extend, and a purchase priced on the valuation when there is one", async () => {
    const withPurchase = await mount(open(["RETURN", "EXTEND", "PURCHASE"]))
    expect(optionLabels(withPurchase)).toEqual(["Return the asset", "Extend month to month", "Buy the asset"])
    expect(text(withPurchase)).toContain("400,000.00 excluding VAT")
    const without = await mount(open(["RETURN", "EXTEND"]))
    expect(optionLabels(without)).toEqual(["Return the asset", "Extend month to month"])
  })

  it("confirms the choice before posting it, with the outcome as the body", async () => {
    mocks.post.mockResolvedValue({ ok: true, body: {} })
    const r = await mount(open(["RETURN", "EXTEND", "PURCHASE"]))
    const purchase = optionButtons(r)[2]
    await act(async () => { purchase.props.onClick() })
    expect(mocks.post).not.toHaveBeenCalled()
    const confirm = r.root.findAllByType("button").find((b) => b.children.join("") === "Confirm my choice")
    await act(async () => { await confirm?.props.onClick() })
    expect(mocks.post).toHaveBeenCalledWith("/api/portal/asset-finance/leases/L1/end-of-term", { outcome: "PURCHASE" }, expect.any(String))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows the refusal message", async () => {
    mocks.post.mockResolvedValue({ ok: false, message: "The purchase option needs a current valuation of the asset; ask the lessor" })
    const r = await mount(open(["RETURN", "EXTEND"]))
    await act(async () => { optionButtons(r)[0].props.onClick() })
    await act(async () => { await r.root.findAllByType("button").find((b) => b.children.join("") === "Confirm my choice")?.props.onClick() })
    expect(r.root.findByProps({ role: "alert" }).children.join("")).toContain("needs a current valuation")
  })

  it("shows the recorded choice and no buttons once chosen", async () => {
    const r = await mount({ kind: "chosen" }, { outcome: "EXTEND", status: "EXTENDING", early: false })
    expect(text(r)).toContain("extend month to month")
    expect(r.root.findAllByType("button")).toHaveLength(0)
  })
})
