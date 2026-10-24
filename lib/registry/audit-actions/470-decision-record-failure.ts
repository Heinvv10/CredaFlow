import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Learning loop (docs/learning-loop/DESIGN.md decision 5): an automated refusal whose decision record could
  // not be written. The refusal's own audit row is still written; this row is the durable trace of the gap.
  DECISION_RECORD_WRITE_FAILED: "DECISION_RECORD_WRITE_FAILED",
} as const)
