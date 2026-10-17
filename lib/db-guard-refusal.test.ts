import { describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { databaseGuardRefusal, GENERIC_GUARD_REFUSAL } from "./db-guard-refusal"

const connector = (code: string, message: string) => new Prisma.PrismaClientUnknownRequestError(
  `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: "test" },
)

describe("databaseGuardRefusal", () => {
  // The shape the countersign route met on the Fair Score audit (2026-10-16).
  it("returns a trigger's own sentence", () => {
    expect(databaseGuardRefusal(connector("23514", "Signed debit-mandate authority is immutable outside an explicit return to review")))
      .toBe("Signed debit-mandate authority is immutable outside an explicit return to review")
    expect(databaseGuardRefusal(connector("P0001", "refused by a guard"))).toBe("refused by a guard")
  })

  it("reads the code and message a raw-query failure carries in meta", () => {
    const raw = new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010", clientVersion: "test", meta: { code: "23514", message: "ERROR: Segregation of duties: no" },
    })
    expect(databaseGuardRefusal(raw)).toBe("Segregation of duties: no")
  })

  // #140 review: a CHECK violation names the table and the constraint.
  it("hides a plain CHECK constraint violation behind a generic sentence", () => {
    const check = connector("23514", 'new row for relation \\"LoanApplication\\" violates check constraint \\"LoanApplication_countersign_complete_check\\"')
    expect(databaseGuardRefusal(check)).toBe(GENERIC_GUARD_REFUSAL)
    expect(GENERIC_GUARD_REFUSAL).not.toMatch(/LoanApplication|constraint/)
  })

  it("does not take 23514 in a message for the SQLSTATE", () => {
    expect(databaseGuardRefusal(new Error("Amount 23514 cents is above the limit"))).toBeNull()
    expect(databaseGuardRefusal(connector("23505", "duplicate key value violates unique constraint 23514"))).toBeNull()
  })

  it("leaves every other failure alone", () => {
    expect(databaseGuardRefusal(new Error("connection reset"))).toBeNull()
    expect(databaseGuardRefusal(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }))).toBeNull()
    expect(databaseGuardRefusal("23514")).toBeNull()
  })
})
