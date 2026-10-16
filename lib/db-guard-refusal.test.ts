import { describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { databaseGuardRefusal } from "./db-guard-refusal"

// The shape the countersign route met on the Fair Score audit (2026-10-16).
const connectorError = new Prisma.PrismaClientUnknownRequestError(
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "Signed debit-mandate authority is immutable outside an explicit return to review", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
  { clientVersion: "test" },
)

describe("databaseGuardRefusal", () => {
  it("returns the guard's own sentence from a trigger refusal", () => {
    expect(databaseGuardRefusal(connectorError))
      .toBe("Signed debit-mandate authority is immutable outside an explicit return to review")
  })

  it("recognises a refusal carried as meta.code on a raw-query failure", () => {
    const raw = new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010", clientVersion: "test", meta: { code: "P0001", message: "ERROR: refused" },
    })
    expect(databaseGuardRefusal(raw)).toBe("The database refused this change.")
  })

  it("leaves every other failure alone", () => {
    expect(databaseGuardRefusal(new Error("connection reset"))).toBeNull()
    expect(databaseGuardRefusal(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002", clientVersion: "test",
    }))).toBeNull()
    expect(databaseGuardRefusal("23514")).toBeNull()
  })
})
