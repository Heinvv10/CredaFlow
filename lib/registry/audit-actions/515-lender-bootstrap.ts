import { defineAuditActions } from "../define"

// The operator provisioned a lender's second person (scripts/lender/bootstrap-admin.ts): not USER_CREATED, which the two-people rule reads as a hold.
export default defineAuditActions({
  LENDER_SECOND_PERSON_PROVISIONED: "LENDER_SECOND_PERSON_PROVISIONED",
} as const)
