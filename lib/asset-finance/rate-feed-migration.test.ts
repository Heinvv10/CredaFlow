import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql } from "@/lib/db-baseline.test-helpers"

// Reads the LATEST definition of each object across the migrations
// (20261016130000_reference_rate_sarb_feed redefines the first two). That the
// rules hold when they run is proven in rate-feed.integration.test.ts.

describe("reference-rate SARB feed migration", () => {
  it("a MANUAL value has a requester and only a MANUAL value does", () => {
    const check = baselineConstraintSql("ReferenceRate_requester_source")
    expect(check).toContain(`("source" = 'MANUAL') = ("requestedById" IS NOT NULL)`)
  })

  it("the decider is never the requester, and an undecided feed row (no requester) passes", () => {
    const check = baselineConstraintSql("ReferenceRate_four_eyes")
    expect(check).toContain(`"decidedById" IS NULL OR "decidedById" IS DISTINCT FROM "requestedById"`)
  })

  it("source never changes, with every column the lifecycle guard already pinned", () => {
    const guard = baselineFunctionSql("guardReferenceRateLifecycle")
    for (const column of ["tenantId", "basis", "effectiveDate", "rate", "source", "requestedById", "createdAt"]) {
      expect(guard).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`)
    }
  })

  it("a row is still born PENDING: the insert guard is untouched", () => {
    expect(baselineFunctionSql("guardReferenceRateInsert")).toContain(`NEW."status" IS DISTINCT FROM 'PENDING'`)
  })
})
