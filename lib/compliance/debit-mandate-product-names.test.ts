import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "../db-baseline.test-helpers"
import {
  CHEQUE_ACCOUNT_LABELS,
  SAVINGS_ACCOUNT_LABELS,
  TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES,
} from "./debit-mandate"

const migration = baselineFunctionSql("canonicalAccountType")

// Every `compact IN (...)` arm, in the order Postgres evaluates them: the first
// is CHEQUE, the second SAVINGS.
const inArms = [...migration.matchAll(/compact IN \(([^)]*)\)/g)]
  .map((arm) => [...arm[1].matchAll(/'([a-z]*)'/g)].map((v) => v[1]))
const likeArms = [...migration.matchAll(/compact LIKE '([a-z]*)%'/g)]
  .map((arm) => arm[1])

// The TypeScript canonicaliser gates the disburse route; the Postgres one gates
// the DISBURSED triggers. A label accepted by only one of them produces the
// worst outcome available: the route accepts the payout and the DB guard then
// raises 23514 mid-transaction. These tests are why changing an account-type
// label is a two-file change, and they fail loudly when it is not.
describe("account-type labels stay in step with the DB canonicaliser", () => {
  it("finds both IN arms and the prefix arm to compare against", () => {
    expect(inArms).toHaveLength(2)
    expect(likeArms.length).toBeGreaterThan(0)
  })

  it("accepts exactly the same cheque labels on both sides", () => {
    expect([...inArms[0]].sort()).toEqual([...CHEQUE_ACCOUNT_LABELS].sort())
  })

  it("accepts exactly the same savings labels on both sides", () => {
    expect([...inArms[1]].sort()).toEqual([...SAVINGS_ACCOUNT_LABELS].sort())
  })

  it("accepts exactly the same product prefixes on both sides", () => {
    expect([...likeArms].sort()).toEqual(
      [...TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES].sort(),
    )
  })

  // Prefix matching belongs to product names only. A generic label promoted to
  // a LIKE arm would accept "currentaccountofsomeoneelse" in Postgres while the
  // exact-match TypeScript side refused it.
  it("prefix-matches product names only, never a generic label", () => {
    for (const prefix of likeArms) {
      expect([
        ...CHEQUE_ACCOUNT_LABELS,
        ...SAVINGS_ACCOUNT_LABELS,
      ]).not.toContain(prefix)
    }
  })
})
