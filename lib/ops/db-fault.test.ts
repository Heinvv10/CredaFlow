import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { isDatabaseInfrastructureError } from "./db-fault"

const known = (code: string) => new Prisma.PrismaClientKnownRequestError("msg", { code, clientVersion: "5.22.0" })

describe("isDatabaseInfrastructureError", () => {
  it.each([
    ["an initialisation error (the connection could not be made)", new Prisma.PrismaClientInitializationError("can't reach", "5.22.0")],
    ["a Rust panic (the query engine died)", new Prisma.PrismaClientRustPanicError("panic", "5.22.0")],
    ["P1001 server unreachable", known("P1001")],
    ["P1002 server timed out", known("P1002")],
    ["P1008 operation timed out", known("P1008")],
    ["P1017 server closed the connection", known("P1017")],
    ["P2024 connection pool timeout", known("P2024")],
  ])("is true for %s", (_name, error) => {
    expect(isDatabaseInfrastructureError(error)).toBe(true)
  })

  // One loan's bad data is that loan's problem and must not fail the tenant.
  it.each([
    ["a unique violation", known("P2002")],
    ["a missing record", known("P2025")],
    ["a plain Error", new Error("boom")],
    ["a string", "P1001"],
    ["undefined", undefined],
  ])("is false for %s", (_name, error) => {
    expect(isDatabaseInfrastructureError(error)).toBe(false)
  })
})
