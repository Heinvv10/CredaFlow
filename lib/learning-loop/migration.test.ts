import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migrations 20261021090000_credit_decision_record,
// 20261021100000_decision_record_automated_refusal and
// 20261023190000_decision_record_subject_trigger; the rules run
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
    // 20261023200000_decision_record_retention: unless the row was pseudonymised.
    expect(flat("CreditDecisionRecord_actor")).toContain(`("actorType" = 'STAFF' AND ("actorUserId" IS NOT NULL OR "pseudonymisedAt" IS NOT NULL))`)
    expect(flat("CreditDecisionRecord_probability_range")).toContain(`"predictedProbability" >= 0 AND "predictedProbability" <= 1`)
    expect(flat("CreditDecisionRecord_hashes_sha256")).toContain(`"inputsHash" ~ '^[0-9a-f]{64}$'`)
  })

  // 20261021100000_decision_record_automated_refusal widened the subject to a lead.
  it("holds a decision to a subject (a lead counts), and the s71 review flag to automated decisions", () => {
    const flat = (name: string) => baselineConstraintSql(name).replace(/\s+/g, " ")
    expect(() => baselineConstraintSql("CreditDecisionRecord_has_subject")).toThrow()
    expect(flat("CreditDecisionRecord_has_subject_or_lead")).toContain(`"applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL OR "leadId" IS NOT NULL`)
    expect(flat("CreditDecisionRecord_s71_review_automated")).toContain(`CHECK (NOT "s71ReviewRequired" OR "actorType" = 'SYSTEM')`)
  })

  // 20261023190000_decision_record_subject_trigger; RUN_DECISION_LOG_IT runs it (subject-trigger.integration.test.ts).
  it("refuses at INSERT a subject id that is not a row of the record's own lender", () => {
    expect(baselineTriggerSql("CreditDecisionRecord_subject_exists")).toMatch(/BEFORE INSERT ON "CreditDecisionRecord"\s+FOR EACH ROW/)
    const fn = baselineFunctionSql("guardCreditDecisionRecordSubjects").replace(/\s+/g, " ")
    for (const [column, table] of [["applicationId", "LoanApplication"], ["loanId", "Loan"], ["clientId", "Client"], ["leadId", "Lead"]]) {
      expect(fn).toContain(`NEW."${column}" IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM public."${table}" WHERE "id" = NEW."${column}" AND "tenantId" = NEW."tenantId")`)
      expect(fn).toContain(`CreditDecisionRecord.${column} is not`)
    }
    // Invoker rights (the default): the lookups run under the caller's row-level security.
    expect(fn).not.toMatch(/SECURITY DEFINER/i)
    expect(fn).toContain("SET search_path = public, pg_temp")
  })

  // 20261023200000_decision_record_retention: the one UPDATE the guard lets through.
  it("lets only pseudonymiseCreditDecisionRecords() pseudonymise, once, and every other column stay as it was", () => {
    const flat = (name: string) => baselineFunctionSql(name).replace(/\s+/g, " ")
    const guard = flat("guardCreditDecisionRecord")
    expect(guard).toContain(`stack LIKE '%PL/pgSQL function "pseudonymiseCreditDecisionRecords"(%'`)
    expect(guard).toContain(`OLD."pseudonymisedAt" IS NULL AND NEW."pseudonymisedAt" IS NOT NULL`)
    expect(guard).toContain(`to_jsonb(NEW) - pseudonymised = to_jsonb(OLD) - pseudonymised`)
    expect(guard).toContain("The credit decision log is append-only")
    const job = flat("pseudonymiseCreditDecisionRecords")
    expect(job).toContain(`IF months IS NULL THEN RETURN 0;`)
    expect(job).toContain(`WHEN 'WRITTEN_OFF' THEN COALESCE(loan."writeOffAt", loan."closedAt", loan."updatedAt")`)
    expect(job).toContain(`IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED') THEN NULL`)
  })

  it("allows a pseudonymised row no reason, actor or subject, and only then; and holds the period to 1..600", () => {
    const flat = (name: string) => baselineConstraintSql(name).replace(/\s+/g, " ")
    expect(flat("CreditDecisionRecord_override_reason")).toContain(`("overridden" AND "pseudonymisedAt" IS NOT NULL AND "overrideReason" IS NULL)`)
    expect(flat("CreditDecisionRecord_has_subject_or_lead")).toContain(`OR "pseudonymisedAt" IS NOT NULL`)
    expect(flat("CreditDecisionRecord_pseudonymised_shape")).toContain(`"pseudonymisedAt" IS NULL OR ("applicationId" IS NULL AND "loanId" IS NULL AND "clientId" IS NULL AND "leadId" IS NULL AND "actorUserId" IS NULL AND "overrideReason" IS NULL)`)
    expect(flat("TenantConfig_decisionRecordRetentionMonths_range")).toContain(`"decisionRecordRetentionMonths" >= 1 AND "decisionRecordRetentionMonths" <= 600`)
  })
})
