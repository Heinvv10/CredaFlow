import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineTriggerSql,
  readBaselineSql,
} from "../db-baseline.test-helpers"

const baseline = readBaselineSql()
const tableSql = (name: string) =>
  baseline.match(new RegExp(`^CREATE TABLE "${name}" \\([\\s\\S]*?^\\);`, "m"))?.[0] ?? ""
const dryRunMessage = baselineFunctionSql("truthful_dry_run_message")
const dryRunAudit = baselineFunctionSql("truthful_dry_run_audit")
const graphEmailLog = baselineFunctionSql("truthful_graph_email_log")
const stageAmbiguous = baselineFunctionSql("stage_email_log_ambiguous_status")
const unlinkedNotification = baselineFunctionSql("guard_unlinked_notification_delivery")

describe("truthful message evidence schema", () => {
  it("separates simulation receipts from provider evidence", () => {
    expect(tableSql("Message")).toContain(`"simulationReceiptId" VARCHAR(512)`)
    expect(dryRunMessage).toContain(`NEW."providerMessageId" := NULL`)
  })

  it("has complete-payload and Graph receipt evidence fields", () => {
    expect(tableSql("Message")).toContain(`"payloadFingerprint" CHAR(64)`)
    expect(tableSql("EmailLog")).toContain(`"providerEvidenceReference" VARCHAR(512)`)
    expect(baseline).toMatch(/^CREATE TYPE "EmailLogStatus" AS ENUM \([^;]*'AMBIGUOUS'/m)
    expect(baselineTriggerSql("EmailLog_stage_ambiguous_status")).toContain(
      `ON "EmailLog" FOR EACH ROW EXECUTE FUNCTION stage_email_log_ambiguous_status()`,
    )
    expect(stageAmbiguous).toContain(`'providerOutcome', 'AMBIGUOUS'`)
    expect(graphEmailLog).toContain(`'providerOutcome', 'AMBIGUOUS'`)
    expect(dryRunAudit).toContain(`'MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED'`)
    expect(graphEmailLog).toContain(`'EMAIL_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED'`)
    expect(baselineTriggerSql("EmailLog_truthful_graph_evidence")).toContain(
      `ON "EmailLog" FOR EACH ROW EXECUTE FUNCTION truthful_graph_email_log()`,
    )
    expect(graphEmailLog).toContain(`CLIENT_REQUEST_ID:`)
  })

  it("links notification projections and blocks unlinked delivery claims", () => {
    expect(baselineConstraintSql("NotificationLog_tenantId_messageId_fkey")).toContain(
      `FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id")`,
    )
    expect(baselineTriggerSql("NotificationLog_truthful_delivery_guard")).toContain(
      `ON "NotificationLog" FOR EACH ROW EXECUTE FUNCTION guard_unlinked_notification_delivery()`,
    )
    expect(dryRunAudit).toMatch(/NEW\."action" := 'MESSAGE_SIMULATED';[\s\S]*?'status', 'SIMULATED'[\s\S]*?'compatibilityCorrection', 'legacy_dry_run_writer'/)
    expect(unlinkedNotification).toContain(`'NOTIFICATION_UNLINKED_DELIVERY_CLAIM_BLOCKED'`)
  })
})
