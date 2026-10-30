import { describe, expect, it } from "vitest"
import { principalsOf, seatConflict, seatMap } from "./seats"

const base = { makerIds: ["maker"], steps: [{ actorId: "l1", authorityHolderId: null }, { actorId: "l2", authorityHolderId: "boss" }], recorders: [{ actorId: "rec", authorityHolderId: "chair" }] }

describe("principals", () => {
  it("are the person and, on a delegation, the delegator behind them", () => {
    expect(principalsOf({ actorId: "a", authorityHolderId: null })).toEqual(["a"])
    expect(principalsOf({ actorId: "a", authorityHolderId: "b" })).toEqual(["a", "b"])
  })
})

describe("seatMap and seatConflict", () => {
  const seats = seatMap(base)
  it.each([
    ["the maker", { actorId: "maker", authorityHolderId: null }, "MAKER"],
    ["an earlier approver", { actorId: "l1", authorityHolderId: null }, "APPROVED"],
    ["a delegate acting on an earlier approver's authority", { actorId: "x", authorityHolderId: "l1" }, "APPROVED"],
    ["a delegator whose delegate already approved", { actorId: "boss", authorityHolderId: null }, "DELEGATOR_ACTED"],
    ["a second delegate of the same delegator", { actorId: "y", authorityHolderId: "boss" }, "DELEGATOR_ACTED"],
    ["the committee recorder", { actorId: "rec", authorityHolderId: null }, "RECORDED"],
    ["the recorder's delegator", { actorId: "chair", authorityHolderId: null }, "RECORDED"],
    ["a delegate of the recorder's delegator", { actorId: "z", authorityHolderId: "chair" }, "RECORDED"],
    ["a delegate of the maker", { actorId: "z", authorityHolderId: "maker" }, "MAKER"],
  ] as const)("refuses %s", (_name, candidate, reason) => {
    expect(seatConflict(seats, candidate)).toBe(reason)
  })

  it("seats a stranger, and a delegate of a stranger", () => {
    expect(seatConflict(seats, { actorId: "new", authorityHolderId: null })).toBeNull()
    expect(seatConflict(seats, { actorId: "new", authorityHolderId: "other" })).toBeNull()
  })

  it("a maker stays a maker even when they also appear as an approver", () => {
    expect(seatMap({ makerIds: ["p"], steps: [{ actorId: "p", authorityHolderId: null }], recorders: [] }).get("p")).toBe("MAKER")
  })
})
