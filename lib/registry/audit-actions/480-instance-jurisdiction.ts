import { defineAuditActions } from "../define"

export default defineAuditActions({
  // The instance's jurisdiction and currency changed (lib/jurisdiction/instance-write.ts), an operator
  // action allowed only before the first loan application or loan.
  INSTANCE_JURISDICTION_SET: "INSTANCE_JURISDICTION_SET",
})
