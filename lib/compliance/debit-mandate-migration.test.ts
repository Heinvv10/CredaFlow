import { describe, expect, it } from "vitest"
import { readBaselineSql } from "../db-baseline.test-helpers"

const complianceType = readBaselineSql()
  .split("\n")
  .find((line) => line.startsWith('CREATE TYPE "ComplianceType" AS ENUM ('))

describe("signed debit-mandate database gate", () => {
  it("registers interrupted signed mandate files as dedicated compliance artifacts", () => {
    expect(complianceType).toContain("'DEBIT_MANDATE_ARTIFACT'")
  })
})
