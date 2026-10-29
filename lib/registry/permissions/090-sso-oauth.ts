import { definePermissions } from "../define"

// Enterprise sign-in and API OAuth clients (lib/sso, lib/lender-api/oauth).
// Both also need a session whose sign-in verified a TOTP code (lib/sso/admin-guard.ts).
export default definePermissions({
  // Configure the lender's SSO connection: it decides who may sign in.
  manage_sso: "SUPER_ADMIN",
  // Register and revoke OAuth clients: each is a standing credential to the lender's book.
  manage_oauth_clients: "SUPER_ADMIN",
} as const)
