import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261021090000_credit_decision_record; the rules run
// against Postgres in RUN_DECISION_LOG_IT (decision-log.integration.test.ts).
describe("CreditDecisionRecord hand-written objects", () => {
  it("is append-only: no UPDATE, DELETE or TRUNCATE", () => {
    expect(baselineTriggerSql("CreditDecisionRecord_append_only")).toMatch(/BEFORE UPDATE OR DELETE ON "CreditDecisionRecord"/)
    expect(baselineTriggerSql("CreditDecisionRecord_guard_truncate")).toMatch(/BEFORE TRUNCATE ON "CreditDecisionRecord"\s+FOR EACH STATEMENT/)
    expect(baselineFunctionSql("guardCreditDecisionRecord")).toContain("The credit decision log is append-only")
  })

  it("holds an override to its reason, a staff decision to its person, and a probability to [0, 1]", () => {
    const flat = (name: string) => baselineConstraintSql(name).replace(/\s+/g, " ")
    expect(flat("CreditDecisionRecord_override_reason")).toContain(`("overridden" AND "overrideReason" IS NOT NULL AND char_length(btrim("overrideReason")) >= 10)`)
    expect(flat("CreditDecisionRecord_actor")).toContain(`("actorType" = 'STAFF' AND "actorUserId" IS NOT NULL)`)
    expect(flat("CreditDecisionRecord_probability_range")).toContain(`"predictedProbability" >= 0 AND "predictedProbability" <= 1`)
    expect(flat("CreditDecisionRecord_hashes_sha256")).toContain(`"inputsHash" ~ '^[0-9a-f]{64}$'`)
    expect(flat("CreditDecisionRecord_has_subject")).toContain(`"applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL`)
  })
})
