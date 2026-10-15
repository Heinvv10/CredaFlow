import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { guardSentence, RecoveryRefusal, refusable } from "./recovery-result"

// The two shapes Prisma gave a trigger's RAISE ... ERRCODE '23514' against a real database.
const ormWrite = new Prisma.PrismaClientUnknownRequestError(
  'Invalid `tx.recoveryCost.create()` invocation\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "A cost\'s legal step belongs to this loan\'s legal matter", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
  { clientVersion: "test" },
)
const rawQuery = new Prisma.PrismaClientKnownRequestError(
  "\nInvalid `prisma.$executeRawUnsafe()` invocation:\n\n\nRaw query failed. Code: `23514`. Message: `ERROR: Costs are recorded before the sale proceeds are applied`",
  { code: "P2010", clientVersion: "test", meta: { code: "23514", message: "ERROR: Costs are recorded before the sale proceeds are applied" } },
)

describe("guardSentence", () => {
  it("reads the sentence out of an ORM write's error", () => {
    expect(guardSentence(ormWrite)).toBe("A cost's legal step belongs to this loan's legal matter")
  })

  it("reads the sentence out of a raw query's error", () => {
    expect(guardSentence(rawQuery)).toBe("Costs are recorded before the sale proceeds are applied")
  })

  it("is null for any other error", () => {
    expect(guardSentence(new Error("connection reset"))).toBeNull()
    expect(guardSentence("23514")).toBeNull()
  })
})

describe("refusable", () => {
  it("answers a refusal, a guard sentence and a unique clash as not_ready, and rethrows anything else", async () => {
    expect(await refusable(async () => { throw new RecoveryRefusal("Not now") })).toEqual({ kind: "not_ready", reason: "Not now" })
    expect(await refusable(async () => { throw ormWrite })).toEqual({ kind: "not_ready", reason: "A cost's legal step belongs to this loan's legal matter" })
    const clash = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    expect(await refusable(async () => { throw clash })).toMatchObject({ kind: "not_ready" })
    await expect(refusable(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(await refusable(async () => ({ kind: "done" as const, id: "r1" }))).toEqual({ kind: "done", id: "r1" })
  })
})
