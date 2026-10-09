import { describe, it, expect } from "vitest"
import { loanIdsFromEvents, resolveBorrower } from "./borrower"

const loansById = new Map([
  ["L1", { id: "L1", reference: "LN-0001", client: { firstName: "Nhlanhla", lastName: "Mocktest" }, product: { name: "Micro Loan" } }],
])

describe("loanIdsFromEvents", () => {
  it("extracts loanId from metadata", () => {
    expect(loanIdsFromEvents([{ metadata: { loanId: "L1" } }])).toEqual(["L1"])
  })

  it("ignores events with no usable metadata rather than throwing", () => {
    expect(loanIdsFromEvents([
      { metadata: null }, { metadata: "nonsense" }, { metadata: [] }, { metadata: { loanId: 42 } },
    ])).toEqual([])
  })

  it("de-duplicates so the follow-up query stays small", () => {
    expect(loanIdsFromEvents([{ metadata: { loanId: "L1" } }, { metadata: { loanId: "L1" } }])).toEqual(["L1"])
  })

  it("excludes empty or whitespace-only loanId", () => {
    expect(loanIdsFromEvents([
      { metadata: { loanId: "" } }, { metadata: { loanId: "   " } },
    ])).toEqual([])
  })
})

describe("resolveBorrower", () => {
  it("resolves the client, loan reference and product", () => {
    expect(resolveBorrower({ metadata: { loanId: "L1" } }, loansById)).toEqual({
      loanId: "L1", clientName: "Nhlanhla Mocktest", loanReference: "LN-0001", productName: "Micro Loan",
    })
  })

  // A funnel event has no loanId; the UI shows its lead instead. Returning null
  // must not be an error path.
  it("returns null when the event has no loanId", () => {
    expect(resolveBorrower({ metadata: {} }, loansById)).toBeNull()
  })

  // Degrade, never throw: a deleted loan must not take the whole queue down.
  it("returns null when the loan is missing", () => {
    expect(resolveBorrower({ metadata: { loanId: "GONE" } }, loansById)).toBeNull()
  })

  it("tolerates a loan with no product", () => {
    const m = new Map([["L2", { id: "L2", reference: "LN-2", client: { firstName: "A", lastName: "B" }, product: null }]])
    expect(resolveBorrower({ metadata: { loanId: "L2" } }, m)?.productName).toBeNull()
  })

  it("returns null for empty or whitespace-only loanId", () => {
    expect(resolveBorrower({ metadata: { loanId: "" } }, loansById)).toBeNull()
    expect(resolveBorrower({ metadata: { loanId: "   " } }, loansById)).toBeNull()
  })
})
