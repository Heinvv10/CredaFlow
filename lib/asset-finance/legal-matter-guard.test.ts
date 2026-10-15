import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { LegalRefusal, legalGuardMessage, refusing } from "./legal-matter-guard"

const raw = (message: string) => Object.assign(new Error(message), { code: "P2010", meta: { code: "23514", message } })

describe("legalGuardMessage", () => {
  it("returns the trigger's sentence from a raw-query failure", () => {
    expect(legalGuardMessage(raw("ERROR: An NCA summons needs a section 129 notice sent at least 10 business days earlier\nCONTEXT: PL/pgSQL"))).toBe(
      "An NCA summons needs a section 129 notice sent at least 10 business days earlier",
    )
  })

  it("reads Prisma's quoted Message form", () => {
    const error = new Prisma.PrismaClientUnknownRequestError("Invalid `prisma.legalMatterStep.create()` invocation: Code: `23514`. Message: `A step is not dated in the future`", { clientVersion: "x" })
    expect(legalGuardMessage(error)).toBe("A step is not dated in the future")
  })

  it("reads the query engine's PostgresError wrapper, with its escaped quotes", () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution:\nConnectorError(ConnectorError { kind: QueryError(PostgresError { code: "23514", message: "A section 129 step names this loan\'s \\"completed\\" notice", severity: "ERROR", detail: None }) })',
      { clientVersion: "x" },
    )
    expect(legalGuardMessage(error)).toBe('A section 129 step names this loan\'s "completed" notice')
  })

  it("is null for anything but a check violation", () => {
    expect(legalGuardMessage(new Error("connection reset"))).toBeNull()
    expect(legalGuardMessage("23514")).toBeNull()
  })
})

describe("refusing", () => {
  it("maps our refusal, the guard's sentence and a unique violation to not_ready, and rethrows the rest", async () => {
    expect(await refusing(async () => { throw new LegalRefusal("No.") }, "dup")).toEqual({ kind: "not_ready", reason: "No." })
    expect(await refusing(async () => { throw raw("ERROR: A legal matter is never deleted") }, "dup")).toEqual({ kind: "not_ready", reason: "A legal matter is never deleted" })
    expect(await refusing(async () => { throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }) }, "dup")).toEqual({ kind: "not_ready", reason: "dup" })
    await expect(refusing(async () => { throw new Error("boom") }, "dup")).rejects.toThrow("boom")
    expect(await refusing(async () => 7, "dup")).toBe(7)
  })
})
