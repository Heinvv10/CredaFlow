import { describe, expect, it } from "vitest"
import { BAD_SHARE_LIMIT, bookHealthChecks, PAR30_LIMIT, type BookFacts } from "./book-health"

const healthy: BookFacts = { bookCents: 1_000_000_00, par30Cents: 100_000_00, loans: 40, badLoans: 4, oldestOpenApplicationDays: 12, kitPersonaClients: 0 }
const failing = (f: BookFacts) => bookHealthChecks(f).filter((c) => !c.pass).map((c) => c.name)

describe("bookHealthChecks", () => {
  it("passes a healthy book and reports each figure", () => {
    expect(failing(healthy)).toEqual([])
    expect(bookHealthChecks(healthy).map((c) => c.value)).toEqual(["10.0%", "10.0%", "12 days", "0 found"])
  })

  it("measures PAR30 by balance over the whole collectible book, at the limit and just past it", () => {
    expect(failing({ ...healthy, par30Cents: healthy.bookCents * PAR30_LIMIT })).toEqual([])
    expect(failing({ ...healthy, par30Cents: healthy.bookCents * PAR30_LIMIT + 1 })).toEqual([expect.stringMatching(/^PAR30/)])
    // By balance, not by count: one large loan in arrears fails a book of many small current ones.
    expect(failing({ ...healthy, loans: 100, par30Cents: 600_000_00 })).toEqual([expect.stringMatching(/^PAR30/)])
  })

  it("holds defaults and write-offs to the share limit", () => {
    expect(failing({ ...healthy, badLoans: healthy.loans * BAD_SHARE_LIMIT })).toEqual([])
    expect(failing({ ...healthy, badLoans: healthy.loans * BAD_SHARE_LIMIT + 1 })).toEqual([expect.stringMatching(/^defaulted/)])
  })

  it("fails a stale pipeline and a kit persona already in the book", () => {
    expect(failing({ ...healthy, oldestOpenApplicationDays: 31, kitPersonaClients: 1 })).toEqual([
      expect.stringMatching(/^oldest open application/), expect.stringMatching(/^Lerato and Mxolisi/),
    ])
  })

  it("passes an empty book", () => {
    expect(failing({ ...healthy, bookCents: 0, par30Cents: 0, loans: 0, badLoans: 0 })).toEqual([])
  })
})
