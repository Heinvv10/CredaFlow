import { describe, it, expect } from "vitest"
import { recurringInstalmentDue } from "./instalment"

describe("recurringInstalmentDue", () => {
  it("returns 0 for an empty schedule", () => {
    expect(recurringInstalmentDue([])).toBe(0)
  })

  it("returns the sole instalment for a single-instalment (micro) loan", () => {
    // Micro loans have one instalment carrying principal + interest (+ any
    // deferred fee); it IS the recurring amount.
    expect(recurringInstalmentDue([{ totalDue: 2100 }])).toBe(2100)
  })

  it("returns instalment 2 for a multi-instalment loan (skips the fee-loaded first)", () => {
    // Instalment 1 = recurring 5000 + deferred initiation fee 1650; the
    // recurring instalment the client was quoted is instalment 2 = 5000.
    const schedule = [
      { totalDue: 6650 }, // fee-loaded instalment 1
      { totalDue: 5000 }, // recurring
      { totalDue: 5000 },
    ]
    expect(recurringInstalmentDue(schedule)).toBe(5000)
  })

  it("returns instalment 2 for an exactly-two-instalment loan", () => {
    // Boundary between single- and multi-instalment: index 1 exists, so the
    // recurring amount is instalment 2, not the fee-loaded instalment 1.
    expect(recurringInstalmentDue([{ totalDue: 6650 }, { totalDue: 5000 }])).toBe(5000)
  })
})
