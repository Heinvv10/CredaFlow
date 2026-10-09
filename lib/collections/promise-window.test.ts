import { describe, expect, it } from "vitest"
import {
  isPromiseKept,
  promiseWindow,
  PROMISE_GRACE_DAYS,
} from "./promise-window"

describe("promiseWindow", () => {
  it("opens when the promise was made and closes after the grace period", () => {
    const { start, end } = promiseWindow({
      noteCreatedAt: new Date("2026-07-01T09:00:00.000Z"),
      promiseDate: new Date("2026-07-05T00:00:00.000Z"),
    })

    expect(start).toEqual(new Date("2026-07-01T09:00:00.000Z"))
    expect(end).toEqual(new Date("2026-07-08T00:00:00.000Z"))
  })

  it("admits money that arrived on the last grace day", () => {
    // The boundary is where a kept promise silently becomes BROKEN, and BROKEN
    // feeds collections escalation and ultimately s129.
    const { start, end } = promiseWindow({
      noteCreatedAt: new Date("2026-07-01T09:00:00.000Z"),
      promiseDate: new Date("2026-07-05T12:00:00.000Z"),
    })
    // Literal, not derived from the same +N arithmetic the code performs —
    // otherwise widening the grace moves both sides and the test cannot fail.
    expect(end).toEqual(new Date("2026-07-08T12:00:00.000Z"))
    const arrivedOnLastGraceDay = new Date("2026-07-08T12:00:00.000Z")

    expect(arrivedOnLastGraceDay >= start).toBe(true)
    expect(arrivedOnLastGraceDay <= end).toBe(true)
  })

  it("keeps the grace period at the documented number of days", () => {
    // Guards the constant itself: widening it forgives late payment the
    // arrears process is entitled to act on, narrowing it breaks kept promises.
    expect(PROMISE_GRACE_DAYS).toBe(3)
  })

  it("does not mutate the caller's promise date", () => {
    const promiseDate = new Date("2026-07-05T00:00:00.000Z")
    promiseWindow({
      noteCreatedAt: new Date("2026-07-01T09:00:00.000Z"),
      promiseDate,
    })

    expect(promiseDate).toEqual(new Date("2026-07-05T00:00:00.000Z"))
  })
})

describe("isPromiseKept", () => {
  it("accepts payment at the 90% threshold", () => {
    expect(isPromiseKept({ promiseAmount: 100_000, totalReceived: 90_000 }))
      .toBe(true)
  })

  it("rejects payment just below the threshold", () => {
    expect(isPromiseKept({ promiseAmount: 100_000, totalReceived: 89_999 }))
      .toBe(false)
  })

  it("never reads a zero-amount promise as kept", () => {
    // An unparseable note yields promiseAmount 0. `0 >= 0 * 0.9` is true, so a
    // naive threshold marks a promise nobody made as honoured — which is how
    // the two implementations of this rule had drifted apart.
    expect(isPromiseKept({ promiseAmount: 0, totalReceived: 0 })).toBe(false)
  })
})
