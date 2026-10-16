import { defineAuditActions } from "../define"

export default defineAuditActions({
  // IsaFlow connection (lib/accounting/isaflow/connection.ts). Never a token.
  ISAFLOW_CONNECTED: "ISAFLOW_CONNECTED",
  ISAFLOW_VERIFIED: "ISAFLOW_VERIFIED",
  ISAFLOW_DISCONNECTED: "ISAFLOW_DISCONNECTED",
  // IsaFlow refused the stored token (or it is bound to another company): dropped, reconnect needed.
  ISAFLOW_NEEDS_RECONNECT: "ISAFLOW_NEEDS_RECONNECT",
  // A connect or verify IsaFlow refused, or an address this deployment does not allow.
  ISAFLOW_CONNECT_REFUSED: "ISAFLOW_CONNECT_REFUSED",
  // IsaFlow draft-journal push (lib/accounting/isaflow/push.ts). Keys and ids only.
  ACCOUNTING_ISAFLOW_PUSH_CLAIMED: "ACCOUNTING_ISAFLOW_PUSH_CLAIMED",
  ACCOUNTING_ISAFLOW_PUSH_RESULT: "ACCOUNTING_ISAFLOW_PUSH_RESULT",
  ACCOUNTING_ISAFLOW_PUSH_RESOLVED: "ACCOUNTING_ISAFLOW_PUSH_RESOLVED",
  // What the read-back before a retry found in IsaFlow.
  ACCOUNTING_ISAFLOW_PUSH_READBACK: "ACCOUNTING_ISAFLOW_PUSH_READBACK",
})
