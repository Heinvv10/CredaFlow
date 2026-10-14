/**
 * Static proof for migration 20261014150000_w4_screening_fic: the SQL holds
 * the same thresholds and rules as the TypeScript. What the triggers and
 * CHECKs do when they run is proven against Postgres by the RUN_SCREENING_IT
 * suites (lib/screening/db-enforcement, lib/fic/db-enforcement).
 */
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"
import { REVIEW_REASON_MIN_LENGTH } from "./policy"
import { CLOSE_NOTE_MIN_LENGTH, GROUNDS_MIN_LENGTH } from "@/lib/fic/str-cases"

describe("migration 20261014150000_w4_screening_fic", () => {
  it("demands the review route's reason length for a screening decision", () => {
    expect(baselineConstraintSql("ScreeningCheck_decision_complete"))
      .toContain(`char_length(btrim(coalesce("decisionReason", ''))) >= ${REVIEW_REASON_MIN_LENGTH}`)
  })

  it("never lets a confirmed sanctions match carry a decision, nor a sanctions match be ACCEPTED", () => {
    const check = baselineConstraintSql("ScreeningCheck_sanctions_never_cleared")
    expect(check).toContain(`NOT ("type" = 'SANCTIONS' AND "result" = 'CONFIRMED_MATCH' AND "decision" IS NOT NULL)`)
    expect(check).toContain(`NOT ("type" = 'SANCTIONS' AND "decision" = 'ACCEPTED')`)
  })

  it("guards APPROVED and DISBURSED with the same blocking rule as lib/screening/state.ts", () => {
    expect(baselineTriggerSql("LoanApplication_a1_guard_screening"))
      .toContain('BEFORE INSERT OR UPDATE OF status ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationScreening"()')
    const fn = baselineFunctionSql("guardLoanApplicationScreening")
    expect(fn).toContain(`NEW.status NOT IN ('APPROVED', 'DISBURSED')`)
    expect(fn).toContain(`SELECT c."screeningProvider" INTO configured`)
    expect(fn).toContain(`ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1`)
    expect(fn).toContain(`s.result = 'ERROR'`)
    expect(fn).toContain(`(s.decision IS NULL OR s.decision = 'REJECTED')`)
  })

  it("keeps screening checks, STR cases, the access log, CTRs and RMCP versions undeletable", () => {
    expect(baselineTriggerSql("ScreeningCheck_guard_record")).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "ScreeningCheck"')
    expect(baselineTriggerSql("SuspiciousReportCase_guard_record")).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "SuspiciousReportCase"')
    expect(baselineTriggerSql("SuspiciousReportAccess_guard_record")).toContain(`'append-only'`)
    expect(baselineTriggerSql("CashThresholdReport_guard_record")).toContain(`'append-only'`)
    expect(baselineTriggerSql("RmcpDocument_guard_record")).toContain('BEFORE UPDATE OR DELETE ON "RmcpDocument"')
    for (const t of ["ScreeningCheck", "SuspiciousReportCase", "SuspiciousReportAccess", "CashThresholdReport", "RmcpDocument"]) {
      expect(baselineTriggerSql(`${t}_guard_truncate`), t).toContain(`BEFORE TRUNCATE ON "${t}"`)
    }
  })

  it("holds the STR route's grounds and closing-note floors", () => {
    const check = baselineConstraintSql("SuspiciousReportCase_outcome_complete")
    expect(check).toContain(`char_length(btrim("grounds")) >= ${GROUNDS_MIN_LENGTH}`)
    expect(check).toContain(`char_length(btrim(coalesce("assessmentNote", ''))) >= ${CLOSE_NOTE_MIN_LENGTH}`)
  })
})
