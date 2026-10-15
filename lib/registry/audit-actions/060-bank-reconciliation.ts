import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Bank reconciliation
  BANK_STATEMENT_IMPORTED: "BANK_STATEMENT_IMPORTED",
  BANK_TXN_RECONCILED: "BANK_TXN_RECONCILED",
  BANK_TXN_IGNORED: "BANK_TXN_IGNORED",
})
