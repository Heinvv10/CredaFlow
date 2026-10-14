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

  it("guards APPROVED and DISBURSED for a client or an entity and its active related parties", () => {
    expect(baselineTriggerSql("LoanApplication_a1_guard_screening"))
      .toContain('BEFORE INSERT OR UPDATE OF status ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationScreening"()')
    const fn = baselineFunctionSql("guardLoanApplicationScreening")
    expect(fn).toContain(`NEW.status NOT IN ('APPROVED', 'DISBURSED')`)
    expect(fn).toContain(`SELECT c."screeningProvider" INTO configured`)
    expect(fn).toContain(`"screeningSubjectRefusal"(NEW."tenantId", NULL, NEW."entityId")`)
    expect(fn).toContain(`r."entityId" = NEW."entityId" AND r.active`)
    expect(fn).not.toContain("clientId\" IS NULL")
  })

  it("refuses a subject with the same rule as lib/screening/state.ts: block, identity, error, open or rejected match", () => {
    const fn = baselineFunctionSql("screeningSubjectRefusal")
    expect(fn).toContain(`b."liftedAt" IS NULL`)
    expect(fn).toContain(`ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1`)
    expect(fn).toContain(`latest_fp IS DISTINCT FROM "screeningCurrentFingerprint"(t, cid, eid)`)
    expect(fn).toContain(`s.result = 'ERROR'`)
    expect(fn).toContain(`(s.decision IS NULL OR s.decision = 'REJECTED')`)
  })

  it("carries a decision only at the same result level, never for sanctions, only with list-entry ids (M1, M2, policy 2026-10-14)", () => {
    const fn = baselineFunctionSql("guardScreeningCheckRecord")
    expect(fn).toContain(`NEW.result IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH')`)
    expect(fn).toContain(`NEW.type <> 'SANCTIONS'`)
    expect(fn).toContain(`p.result = NEW.result`)
    expect(fn).toContain(`NEW.decision IN ('FALSE_POSITIVE', 'ACCEPTED')`)
    expect(fn).toContain(`jsonb_array_length(NEW.matches) > 0`)
    expect(fn).toContain(`coalesce(btrim(m->>'listEntryId'), '') = ''`)
    expect(fn).toContain(`CONSTRAINT = 'ScreeningCheck_subject_fingerprint'`)
  })

  it("raises a sticky block on a confirmed sanctions match or a REJECTED decision, lifted only by a SUPER_ADMIN, with the review reason floor", () => {
    const record = baselineFunctionSql("recordScreeningBlock")
    expect(record).toContain(`NEW.type = 'SANCTIONS' AND NEW.result = 'CONFIRMED_MATCH'`)
    expect(record).toContain(`NEW.decision = 'REJECTED'`)
    expect(baselineFunctionSql("guardScreeningBlock")).toContain(`u.role = 'SUPER_ADMIN' AND u.active`)
    expect(baselineConstraintSql("ScreeningBlock_lift_complete")).toContain(`char_length(btrim(coalesce("liftReason", ''))) >= ${REVIEW_REASON_MIN_LENGTH}`)
  })

  it("enforces maker-checker per lender (requireSecondReviewer) on screening reviews, STR decisions and RMCP approvals", () => {
    const fn = baselineFunctionSql("enforceSecondReviewer")
    expect(fn).toContain(`SELECT c."requireSecondReviewer" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), true)`)
    expect(fn).toContain(`NEW."reviewedById" = NEW."triggeredById"`)
    expect(fn).toContain(`NEW."assessedById" = NEW."raisedById"`)
    expect(fn).toContain(`NEW."approvedById" = NEW."uploadedById"`)
    for (const t of ["ScreeningCheck", "SuspiciousReportCase", "RmcpDocument"]) {
      expect(baselineTriggerSql(`${t}_second_reviewer`), t).toContain(`BEFORE INSERT OR UPDATE ON "${t}"`)
      expect(() => baselineConstraintSql(`${t}_maker_checker`), t).toThrow()
    }
  })

  it("round 2: identity-bound carry, length-prefixed fingerprints, fingerprint-based staleness, entity-context blocks", () => {
    expect(baselineFunctionSql("guardScreeningCheckRecord")).toContain(`p."subjectFingerprint" = NEW."subjectFingerprint"`)
    expect(baselineFunctionSql("screeningFingerprintField")).toContain(`char_length(v)::text || ':' || v`)
    expect(baselineFunctionSql("screeningPersonFingerprint")).toContain(`"screeningFingerprintField"(regexp_replace(btrim(first_name)`)
    expect(baselineFunctionSql("screeningEntityFingerprint")).toContain(`"screeningFingerprintField"(entity_type)`)
    expect(baselineFunctionSql("markScreeningStaleOnIdentityChange")).toContain(`"screeningPersonFingerprint"(OLD."firstName"`)
    expect(baselineFunctionSql("screeningEntityContextBlocked")).toContain(`b."contextEntityId" = eid`)
    expect(baselineFunctionSql("guardLoanApplicationScreening")).toContain(`"screeningEntityContextBlocked"(NEW."tenantId", NEW."entityId")`)
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
