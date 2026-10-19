import { describe, expect, it, vi } from "vitest"
import { loadDealExceptions, type DealExceptionsDb } from "./deal-exceptions"

function fakeDb() {
  const findMany = vi.fn().mockResolvedValue([])
  const db = { entityRelationship: { findMany }, loan: { findMany } } as unknown as DealExceptionsDb
  return { db, loanFindMany: findMany }
}

const base = { applicationId: "app1", entityId: null, clientId: "c1" }

describe("loadDealExceptions: the deal's own booked loan", () => {
  it("excludes the loan the deal booked from the existing-exposure query", async () => {
    const { db, loanFindMany } = fakeDb()
    await loadDealExceptions(db, "t1", { ...base, loanId: "loan-own" })
    const where = loanFindMany.mock.calls.at(-1)?.[0].where
    expect(where.id).toEqual({ not: "loan-own" })
  })

  it("does not filter by id when the deal has no booked loan", async () => {
    const { db, loanFindMany } = fakeDb()
    await loadDealExceptions(db, "t1", { ...base, loanId: null })
    expect(loanFindMany.mock.calls.at(-1)?.[0].where).not.toHaveProperty("id")
  })
})
