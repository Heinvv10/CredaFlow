import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Staging and suspension policy, and the PD/LGD table (lib/ifrs9/store.ts).
  IFRS9_SETTINGS_UPDATED: "IFRS9_SETTINGS_UPDATED",
  IFRS9_PARAMETERS_REPLACED: "IFRS9_PARAMETERS_REPLACED",
  // A SICR flag set on or cleared from one loan.
  IFRS9_SICR_FLAG_SET: "IFRS9_SICR_FLAG_SET",
  IFRS9_SICR_FLAG_CLEARED: "IFRS9_SICR_FLAG_CLEARED",
  // A staging run written (the monthly cron and on-demand runs).
  IFRS9_RUN_CREATED: "IFRS9_RUN_CREATED",
  // The loan-level ECL export downloaded (it lists every loan's exposure).
  IFRS9_REPORT_EXPORTED: "IFRS9_REPORT_EXPORTED",
  // An operator recorded the missing closed / written-off date of a loan in a terminal status (scripts/lender/set-exit-date.ts).
  IFRS9_LOAN_EXIT_DATE_SET: "IFRS9_LOAN_EXIT_DATE_SET",
})
