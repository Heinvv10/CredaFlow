import { describe, expect, it } from "vitest"
import { disbursementGuardViolation, isCheckViolation } from "./guard-violation"

// The real RAISE texts, copied from the payout guards in
// the baseline migration. If a guard's wording changes without this
// list changing, the route silently reverts to a bare 500.
const GUARD_MESSAGES = [
  "Loan disbursement requires a complete customer-signed debit mandate",
  "Loan disbursement requires the signed mandate bank statement to match the complete payout bank tuple",
  "Loan disbursement requires exact debit-mandate, banking and document evidence",
  "Loan disbursement requires complete provider countersign evidence bound to the exact signed agreement",
  "Loan disbursement requires exactly one completed agreement artifact with an explicit boolean credit-life election",
]

/** Prisma surfaces a trigger RAISE differently depending on how it was issued. */
function knownRequestError(dbMessage: string) {
  const e = new Error(
    `Invalid \`prisma.loanApplication.update()\` invocation:\n\nRaw query failed. Code: \`23514\`. Message: \`${dbMessage}\``,
  )
  Object.assign(e, { code: "P2010", meta: { code: "23514", message: dbMessage } })
  return e
}

function unknownRequestError(dbMessage: string) {
  return new Error(
    `Invalid \`prisma.loanApplication.update()\` invocation:\n\nERROR: ${dbMessage}\nCONTEXT: PL/pgSQL function "guardLoanApplicationDebitMandate"() line 42`,
  )
}

function nestedCauseError(dbMessage: string) {
  const driver = new Error(dbMessage)
  Object.assign(driver, { code: "23514" })
  const wrapper = new Error("An operation failed because it depends on one or more records")
  Object.assign(wrapper, { cause: driver })
  return wrapper
}

describe("disbursementGuardViolation", () => {
  for (const message of GUARD_MESSAGES) {
    it(`recognises "${message.slice(0, 45)}…" as a known-request error`, () => {
      expect(disbursementGuardViolation(knownRequestError(message))).toBe(message)
    })
  }

  it("recognises the guard under an unknown-request wrapper", () => {
    const message = GUARD_MESSAGES[1]
    expect(disbursementGuardViolation(unknownRequestError(message))).toBe(message)
  })

  it("recognises the guard nested under `cause`", () => {
    const message = GUARD_MESSAGES[0]
    expect(disbursementGuardViolation(nestedCauseError(message))).toBe(message)
  })

  it("returns the guard's own sentence, not a generic summary", () => {
    // The operator must be told WHICH evidence is missing. A single generic
    // "payout blocked" string would be a regression to the bare 500.
    const bankTuple = disbursementGuardViolation(knownRequestError(GUARD_MESSAGES[1]))
    const mandate = disbursementGuardViolation(knownRequestError(GUARD_MESSAGES[0]))
    expect(bankTuple).not.toBe(mandate)
    expect(bankTuple).toContain("bank statement")
    expect(mandate).toContain("customer-signed debit mandate")
  })

  it("does NOT claim an unrelated failure is a payout refusal", () => {
    // Mislabelling an outage as a compliance refusal would send staff chasing
    // customer paperwork during an infrastructure failure.
    expect(disbursementGuardViolation(new Error("connect ECONNREFUSED 10.0.0.1:5432"))).toBeNull()
    expect(disbursementGuardViolation(new Error("Timed out fetching a new connection"))).toBeNull()
    expect(disbursementGuardViolation(undefined)).toBeNull()
    expect(disbursementGuardViolation(null)).toBeNull()
  })

  it("does not fire on an unrelated 23514 from another table", () => {
    const other = knownRequestError("new row violates check constraint \"Client_some_other_rule\"")
    expect(disbursementGuardViolation(other)).toBeNull()
  })
})

describe("isCheckViolation", () => {
  it("detects the SQLSTATE wherever Prisma exposed it", () => {
    expect(isCheckViolation(knownRequestError(GUARD_MESSAGES[0]))).toBe(true)
    expect(isCheckViolation(nestedCauseError(GUARD_MESSAGES[0]))).toBe(true)
    expect(isCheckViolation(new Error("connect ECONNREFUSED"))).toBe(false)
  })
})
