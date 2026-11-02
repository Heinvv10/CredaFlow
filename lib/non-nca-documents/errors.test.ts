import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { databaseMessage, isConcurrencyLoss, isDatabaseRefusal } from "./errors"

const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("Invalid invocation", { code, clientVersion: "5", meta })
const unknown = (pgCode: string) => new Prisma.PrismaClientUnknownRequestError(`ConnectorError(PostgresError { code: "${pgCode}", message: "A guard said no", severity: "ERROR" })`, { clientVersion: "5" })

describe("what the database said", () => {
  it("a trigger, CHECK or constraint is a refusal", () => {
    for (const error of [known("P2002"), known("P2003"), known("P2010", { code: "23514" }), known("P2010", { code: "P0001" }), unknown("23514"), unknown("P0001")]) {
      expect(isDatabaseRefusal(error)).toBe(true)
      expect(isConcurrencyLoss(error)).toBe(false)
    }
    expect(databaseMessage(unknown("23514"))).toBe("A guard said no")
  })

  it("a lost race, a deadlock and a timeout are a concurrent change, not a refusal", () => {
    for (const error of [known("P2034"), known("P2028"), known("P2010", { code: "40001" }), known("P2010", { code: "40P01" }), known("P2010", { code: "55P03" }), unknown("40001")]) {
      expect(isConcurrencyLoss(error)).toBe(true)
      expect(isDatabaseRefusal(error)).toBe(false)
    }
  })

  it("anything else is a fault: neither", () => {
    for (const error of [known("P1001"), known("P2024"), known("P2010", { code: "42P01" }), unknown("XX000"), new Error("boom"), null]) {
      expect(isDatabaseRefusal(error)).toBe(false)
      expect(isConcurrencyLoss(error)).toBe(false)
    }
  })
})
