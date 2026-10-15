import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Operator support access (lib/operator/): a lender's grant and revocation,
  // and every use or refused use of it by an operator user. Written under the
  // lender's tenantId so the lender's own audit log shows them.
  SUPPORT_ACCESS_GRANTED: "SUPPORT_ACCESS_GRANTED",
  SUPPORT_ACCESS_GRANT_REFUSED: "SUPPORT_ACCESS_GRANT_REFUSED",
  SUPPORT_ACCESS_REVOKED: "SUPPORT_ACCESS_REVOKED",
  SUPPORT_ACCESS_USED: "SUPPORT_ACCESS_USED",
  SUPPORT_ACCESS_REFUSED: "SUPPORT_ACCESS_REFUSED",
  // Operator console (lib/operator/console/). Lender actions are written under
  // the lender's tenantId; operator-user actions have no tenant. Never a
  // password, token or reset link.
  TENANT_SUSPENDED: "TENANT_SUSPENDED",
  TENANT_REACTIVATED: "TENANT_REACTIVATED",
  LENDER_ADMIN_INVITED: "LENDER_ADMIN_INVITED",
  LENDER_ADMIN_RESET_LINK_SENT: "LENDER_ADMIN_RESET_LINK_SENT",
  OPERATOR_USER_INVITED: "OPERATOR_USER_INVITED",
  OPERATOR_USER_DEACTIVATED: "OPERATOR_USER_DEACTIVATED",
  OPERATOR_USER_RESET_LINK_SENT: "OPERATOR_USER_RESET_LINK_SENT",
  OPERATOR_USER_REACTIVATED: "OPERATOR_USER_REACTIVATED",
  OPERATOR_USER_TOTP_RESET: "OPERATOR_USER_TOTP_RESET",
  // A lender-admin reset the console refused (rate limit, a fresh self-service link).
  LENDER_ADMIN_RESET_REFUSED: "LENDER_ADMIN_RESET_REFUSED",
})
