import { definePermissions } from "../define"

// Record that a committee condition is met (lib/approval/conditions.ts): the agreement is not signed and the loan not paid out until each one is.
export default definePermissions({
  clear_committee_conditions: "LOAN_ADMIN",
} as const)
