import { describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { baselineIndexSql } from "../db-baseline.test-helpers"
import {
  isUniqueConstraintViolation,
  OPEN_APPLICATION_STATUSES,
} from "./open-application"

describe("open application invariant", () => {
  it("keeps the application states covered by the database invariant explicit", () => {
    expect(OPEN_APPLICATION_STATUSES).toEqual([
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
    ])
  })

  it("keeps the partial unique index aligned with the shared open-state list", () => {
    const migration = baselineIndexSql("LoanApplication_one_open_per_client_product_idx")
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "LoanApplication_one_open_per_client_product_idx"',
    )
    for (const status of OPEN_APPLICATION_STATUSES) {
      expect(migration).toContain(`'${status}'::"AppStatus"`)
    }
    expect(migration).not.toContain("'DECLINED'")
    expect(migration).not.toContain("'DISBURSED'")
    expect(migration).not.toContain("'CANCELLED'")
  })

  it("recognises Prisma unique violations without swallowing other database errors", () => {
    expect(isUniqueConstraintViolation(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))).toBe(true)
    expect(isUniqueConstraintViolation(new Prisma.PrismaClientKnownRequestError(
      "Transaction conflict",
      { code: "P2034", clientVersion: "5.x" },
    ))).toBe(false)
    expect(isUniqueConstraintViolation(new Error("P2002"))).toBe(false)
  })
})
