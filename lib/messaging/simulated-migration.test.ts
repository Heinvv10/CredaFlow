import { describe, expect, it } from "vitest"
import { baselineFunctionSql, baselineTriggerSql } from "../db-baseline.test-helpers"

const dryRunMessage = baselineFunctionSql("truthful_dry_run_message")
const dryRunAudit = baselineFunctionSql("truthful_dry_run_audit")
const lastOutbound = baselineFunctionSql("truthful_last_outbound")

describe("SIMULATED message database guards", () => {
  it("rewrites dry-run writes on Message, Conversation, and AuditLog truthfully", () => {
    expect(baselineTriggerSql("Message_truthful_dry_run")).toContain(
      `ON "Message" FOR EACH ROW EXECUTE FUNCTION truthful_dry_run_message()`,
    )
    expect(baselineTriggerSql("Conversation_truthful_last_outbound")).toContain(
      `ON "Conversation" FOR EACH ROW`,
    )
    // INSERT only, and only for Message rows (20261031130000): the restricted audit_redactor
    // must never enter these functions, which read "Message".
    expect(baselineTriggerSql("AuditLog_truthful_dry_run")).toContain(
      `BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."entity" = 'Message') EXECUTE FUNCTION truthful_dry_run_audit()`,
    )
    expect(baselineTriggerSql("AuditLog_legacy_placeholder_guard")).toContain(
      `BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW."entity" = 'Message') EXECUTE FUNCTION guard_legacy_placeholder_audit()`,
    )
    expect(dryRunMessage).toContain(`"status" = 'SIMULATED'`)
    expect(lastOutbound).toContain(`MAX(message."sentAt")`)
    expect(dryRunAudit).toContain(`NEW."action" := 'MESSAGE_SIMULATED'`)
  })

  it("strips fabricated provider acceptance from simulated messages and audits", () => {
    expect(dryRunAudit).toContain(`"status" = 'SIMULATED'`)
    expect(dryRunAudit).toContain(`'providerAcceptedAt', NULL`)
    expect(dryRunAudit).toContain(`'simulationCompletedAt'`)
    expect(dryRunMessage).toContain(`NEW."dispatchProviderAcceptedAt" := NULL`)
  })
})
