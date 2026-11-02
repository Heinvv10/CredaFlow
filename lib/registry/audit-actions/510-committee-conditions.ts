import { defineAuditActions } from "../define"

// A committee condition of an approved application was recorded as met (lib/approval/conditions.ts).
export default defineAuditActions({
  COMMITTEE_CONDITION_CLEARED: "COMMITTEE_CONDITION_CLEARED",
} as const)
