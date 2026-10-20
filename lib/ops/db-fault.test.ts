import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { isDatabaseInfrastructureError } from "./db-fault"

const known = (code: string) => new Prisma.PrismaClientKnownRequestError("msg", { code, clientVersion: "5.22.0" })
// How the engine reports a statement Postgres refused: the driver's SQLSTATE is inside the message (lib/db-guard-refusal.ts).
const unknownWithSqlState = (code: string, message = "refused") => new Prisma.PrismaClientUnknownRequestError(
  `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: "5.22.0" },
)

describe("isDatabaseInfrastructureError", () => {
  it.each([
    ["an initialisation error (the connection could not be made)", new Prisma.PrismaClientInitializationError("can't reach", "5.22.0")],
    ["a Rust panic (the query engine died)", new Prisma.PrismaClientRustPanicError("panic", "5.22.0")],
    ["P1001 server unreachable", known("P1001")],
    ["P1002 server timed out", known("P1002")],
    ["P1008 operation timed out", known("P1008")],
    ["P1017 server closed the connection", known("P1017")],
    ["P2024 connection pool timeout", known("P2024")],
    ["P2028 transaction API error (the transaction was closed under it)", known("P2028")],
    ["P2034 write conflict or deadlock", known("P2034")],
    ["P2037 too many database connections", known("P2037")],
    ["an unknown request error (the engine's connection errors surface as this)", new Prisma.PrismaClientUnknownRequestError("Error in PostgreSQL connection", { clientVersion: "5.22.0" })],
    ["an unknown request error for a server shutdown (SQLSTATE 57P01)", unknownWithSqlState("57P01", "terminating connection due to administrator command")],
    ["an unknown request error for a serialization failure (SQLSTATE 40001)", unknownWithSqlState("40001", "could not serialize access")],
  ])("is true for %s", (_name, error) => {
    expect(isDatabaseInfrastructureError(error)).toBe(true)
  })

  // One loan's bad data is that loan's problem and must not fail the tenant.
  it.each([
    // A trigger's RAISE and a CHECK violation also arrive as an unknown request error, but they are about the row.
    ["a trigger RAISE (SQLSTATE 23514)", unknownWithSqlState("23514", "Signed debit-mandate authority is immutable")],
    ["a CHECK violation (SQLSTATE 23514)", unknownWithSqlState("23514", "new row violates check constraint")],
    ["a trigger RAISE with no named SQLSTATE (P0001)", unknownWithSqlState("P0001", "refused by a guard")],
    ["a foreign-key violation (SQLSTATE 23503)", unknownWithSqlState("23503", "violates foreign key constraint")],
    ["a unique violation", known("P2002")],
    ["a missing record", known("P2025")],
    ["a plain Error", new Error("boom")],
    ["a string", "P1001"],
    ["undefined", undefined],
  ])("is false for %s", (_name, error) => {
    expect(isDatabaseInfrastructureError(error)).toBe(false)
  })
})
