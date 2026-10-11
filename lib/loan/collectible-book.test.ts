import { describe, it, expect } from "vitest"
import {
  COLLECTIBLE_STATUSES,
  SETTLED_STATUSES,
  collectibleLoanWhere,
  collectibleParWhere,
} from "./collectible-book"

// Mirrors prisma/schema.prisma's LoanStatus. Written out so the split below is
// checked against the real enum rather than against itself.
const ALL_LOAN_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "DEFAULTED",
  "PENDING_WRITE_OFF",
  "WRITTEN_OFF",
  "RESTRUCTURED",
  "CANCELLED",
] as const

describe("the collectible book", () => {
  it("partitions every LoanStatus exactly once", () => {
    const collectible = [...COLLECTIBLE_STATUSES] as string[]
    const settled = [...SETTLED_STATUSES] as string[]
    expect([...collectible, ...settled].sort()).toEqual([...ALL_LOAN_STATUSES].sort())
    expect(new Set([...collectible, ...settled]).size).toBe(ALL_LOAN_STATUSES.length)
  })

  it("keeps every still-owed status in the book", () => {
    // PENDING_WRITE_OFF is the one that bit: a loan parked awaiting write-off
    // approval is still owed, and is not in the write-off line yet either, so
    // excluding it put it in no figure at all.
    for (const s of ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"]) {
      expect(COLLECTIBLE_STATUSES as readonly string[]).toContain(s)
    }
  })

  it("keeps settled and forgiven debt out", () => {
    // WRITTEN_OFF retains its last daysInArrears/arrearsAmount, so including it
    // would double-count against the write-off line and inflate arrears.
    for (const s of ["COMPLETED", "CANCELLED", "WRITTEN_OFF"]) {
      expect(COLLECTIBLE_STATUSES as readonly string[]).not.toContain(s)
    }
  })
})

describe("where builders", () => {
  it("scopes to the tenant and the book", () => {
    expect(collectibleLoanWhere("t1")).toEqual({
      tenantId: "t1",
      status: { in: ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"] },
    })
  })

  it("narrows to a DPD threshold at or beyond the boundary", () => {
    for (const days of [1, 30, 60, 90]) {
      expect(collectibleParWhere("t1", days)).toEqual({
        tenantId: "t1",
        status: { in: ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED"] },
        daysInArrears: { gte: days },
      })
    }
  })

  it("gives the PAR numerator the same population as its denominator", () => {
    // A numerator drawn from a wider population than its denominator prints a
    // ratio above 100%.
    const book = collectibleLoanWhere("t1")
    const par = collectibleParWhere("t1", 30)
    expect(par.status).toEqual(book.status)
    expect(par.tenantId).toBe(book.tenantId)
  })

  it("does not mutate the exported constant", () => {
    const before = [...COLLECTIBLE_STATUSES]
    collectibleLoanWhere("t1")
    collectibleParWhere("t1", 30)
    expect([...COLLECTIBLE_STATUSES]).toEqual(before)
  })
})
