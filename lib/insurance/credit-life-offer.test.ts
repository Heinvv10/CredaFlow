import { afterEach, describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { creditLifeOfferFindFirstArgs, loadCreditLifeOffer } from "./credit-life-offer"

const row = { id: "cl-1", name: "Synthetic Cover", insurerId: "ins-1", insurer: { name: "Synthetic Insurer" } }
const db = () => ({ insuranceProduct: { findFirst: vi.fn(async () => row) } })

describe("loadCreditLifeOffer: the one read of what a client is offered", () => {
  afterEach(() => resetActiveJurisdiction())

  it("reads the offer on an instance that has not loaded its jurisdiction, and on a South African one", async () => {
    const unloaded = db()
    expect(await loadCreditLifeOffer(unloaded as never, "t1")).toBe(row)
    expect(unloaded.insuranceProduct.findFirst).toHaveBeenCalledWith(creditLifeOfferFindFirstArgs("t1"))
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    expect(await loadCreditLifeOffer(db() as never, "t1")).toBe(row)
  })

  it("offers a new application on a Lesotho instance nothing, whatever product rows exist", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const lesotho = db()
    expect(await loadCreditLifeOffer(lesotho as never, "t1")).toBeNull()
    expect(lesotho.insuranceProduct.findFirst).not.toHaveBeenCalled()
  })

  it("goes by the application's own regime once it has one: an NCA_PASQ application that pre-dates the switch keeps its offer", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(await loadCreditLifeOffer(db() as never, "t1", "NCA_PASQ")).toBe(row)
  })

  it("and a KEY_FACTS application has none whatever the process thinks it is", async () => {
    expect(await loadCreditLifeOffer(db() as never, "t1", "KEY_FACTS")).toBeNull()
  })
})
