/**
 * Static proof for migration 20261014150000_collections_engine: the SQL holds
 * the same scheme numbers as scheme-rules.ts. What the CHECKs, indexes and
 * triggers do when they run is proven against Postgres by
 * collections-engine.integration.test.ts.
 */
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineIndexSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"
import { MAX_PRESENTMENTS_PER_CYCLE, MAX_TRACKING_DAYS, MIN_TRACKING_DAYS } from "./scheme-rules"
import { LIVE_MANDATE_STATUSES, MANDATE_TRANSITIONS } from "./state-machine"

describe("migration 20261014150000_collections_engine", () => {
  it("caps presentments at the scheme limit", () => {
    expect(baselineConstraintSql("CollectionInstruction_presentment_cap")).toContain(`"presentmentNo" BETWEEN 1 AND ${MAX_PRESENTMENTS_PER_CYCLE}`)
  })

  it("bounds tracking days on mandates and instructions", () => {
    const window = `"trackingDays" BETWEEN ${MIN_TRACKING_DAYS} AND ${MAX_TRACKING_DAYS}`
    expect(baselineConstraintSql("DebitMandate_terms_valid")).toContain(window)
    expect(baselineConstraintSql("CollectionInstruction_tracking_days")).toContain(window)
  })

  it("allows one live mandate per loan, using the engine's own list of live statuses", () => {
    const index = baselineIndexSql("DebitMandate_one_live_per_loan")
    expect(index).toContain(`("tenantId", "loanId")`)
    expect(index).toContain(`IN (${LIVE_MANDATE_STATUSES.map((s) => `'${s}'`).join(", ")})`)
  })

  it("encodes exactly the state machine's transitions in the status trigger", () => {
    const fn = baselineFunctionSql("guardDebitMandateStatus")
    for (const [from, to] of Object.entries(MANDATE_TRANSITIONS)) {
      if (to.length === 0) continue
      const target = to.length === 1 ? `NEW.status = '${to[0]}'` : `NEW.status IN (${to.map((s) => `'${s}'`).join(", ")})`
      expect(fn).toContain(`(OLD.status = '${from}' AND ${target})`)
    }
    expect(baselineTriggerSql("DebitMandate_guard_status")).toContain('BEFORE INSERT OR UPDATE ON "DebitMandate"')
  })

  it("refuses instructions on a mandate that is not ACTIVE, after the CHECKs have run", () => {
    expect(baselineTriggerSql("CollectionInstruction_require_active_mandate")).toContain('AFTER INSERT ON "CollectionInstruction"')
    expect(baselineFunctionSql("guardCollectionInstructionMandate")).toContain("m.status IS DISTINCT FROM 'ACTIVE'")
  })

  it("keeps each presentment number once per instalment per mandate, and one in flight", () => {
    expect(baselineIndexSql("CollectionInstruction_presentment_once")).toContain(`("mandateId", "repaymentScheduleId", "presentmentNo")`)
    expect(baselineIndexSql("CollectionInstruction_one_open_per_instalment")).toContain(`IN ('PENDING', 'SUBMITTING', 'SUBMITTED')`)
  })

  it("makes result ingestion idempotent and books one receipt per result", () => {
    expect(baselineIndexSql("CollectionResult_tenantId_provider_resultKey_key")).toContain(`("tenantId", "provider", "resultKey")`)
    expect(baselineIndexSql("CollectionResult_payment_once")).toContain(`("paymentId")`)
  })
})
