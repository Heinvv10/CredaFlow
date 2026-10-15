import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Tenant administration (app/api/admin/tenants).
  TENANT_CREATED: "TENANT_CREATED",
  TENANT_COLOURS_UPDATED: "TENANT_COLOURS_UPDATED",
  // Borrower-facing languages switched on or off (lib/i18n). Turning one on
  // puts its catalogue in front of borrowers, so who did it is kept.
  TENANT_LANGUAGES_UPDATED: "TENANT_LANGUAGES_UPDATED",
  // Lender identity (lib/config/identity-write.ts) — legal name, NCR/FSP/
  // company-reg numbers, registered office and contact details.
  LENDER_IDENTITY_UPDATED: "LENDER_IDENTITY_UPDATED",
  // Letterhead logo (lib/config/lender-logo.ts): the file's sha256, never the bytes.
  LENDER_LOGO_UPDATED: "LENDER_LOGO_UPDATED",
  LENDER_LOGO_REMOVED: "LENDER_LOGO_REMOVED",
  // First SUPER_ADMIN of a lender and the break-glass reset of a locked-out
  // one (scripts/lender/bootstrap-admin.ts). Never carry a credential.
  SUPER_ADMIN_BOOTSTRAPPED: "SUPER_ADMIN_BOOTSTRAPPED",
  SUPER_ADMIN_BREAK_GLASS_RESET: "SUPER_ADMIN_BREAK_GLASS_RESET",
})
