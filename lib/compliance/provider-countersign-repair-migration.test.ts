import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
} from "../db-baseline.test-helpers"

const repair = [
  baselineConstraintSql("LoanApplication_countersign_complete_check"),
  baselineFunctionSql("guardLoanApplicationProviderCountersign"),
].join("\n")

describe("provider countersign forward repair migration", () => {
  it("reinstalls the countersign constraint and guard with explicit NULL-safe hash checks", () => {
    expect(repair).toContain(
      `"agreementCountersignatureSha256" IS NOT NULL`,
    )
    expect(repair).toContain(
      `"agreementCountersignedDocumentSha256" IS NOT NULL`,
    )
    expect(repair).toContain(
      `NEW."agreementCountersignatureSha256" IS NULL`,
    )
    expect(repair).toContain(
      `NEW."agreementCountersignedDocumentSha256" IS NULL`,
    )
  })
})
