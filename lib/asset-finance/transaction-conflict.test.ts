import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { isTransactionConflict } from "./transaction-conflict"

// The error shapes below are the ones Prisma raised against Postgres 16 for a
// real deadlock and a real serialization failure (raw query and model query).
const clientVersion = "test"
const rawFailure = (sqlState: string) =>
  new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`.`, {
    code: "P2010", clientVersion, meta: { code: sqlState, message: "ERROR: deadlock detected" },
  })
const modelDeadlock = (sqlState: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "deadlock detected", severity: "ERROR" }) })`,
    { clientVersion },
  )

describe("isTransactionConflict", () => {
  it.each([
    ["a raw-query deadlock (P2010, meta.code 40P01)", rawFailure("40P01")],
    ["a raw-query serialization failure (P2010, meta.code 40001)", rawFailure("40001")],
    ["a model-query write conflict (P2034)", new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock", { code: "P2034", clientVersion })],
    ["a model-query deadlock (unknown request, 40P01 in the message)", modelDeadlock("40P01")],
    ["a model-query serialization failure (unknown request, 40001 in the message)", modelDeadlock("40001")],
  ])("is true for %s", (_label, error) => {
    expect(isTransactionConflict(error)).toBe(true)
  })

  it.each([
    ["a raw-query check violation (P2010, 23514)", rawFailure("23514")],
    ["a raw-query lock timeout (P2010, 55P03)", rawFailure("55P03")],
    ["a unique violation (P2002)", new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion })],
    ["a trigger refusal (unknown request, 23514)", modelDeadlock("23514")],
    ["a plain Error naming 40P01", Object.assign(new Error("40P01"), { code: "40P01" })],
    ["a non-error", "40P01"],
  ])("is false for %s", (_label, error) => {
    expect(isTransactionConflict(error)).toBe(false)
  })
})
