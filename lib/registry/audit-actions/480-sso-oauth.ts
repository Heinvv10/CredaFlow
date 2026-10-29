import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Enterprise sign-in (lib/sso) and API OAuth clients (lib/lender-api/oauth).
  // Ids, flags and role names only: never a client secret, an assertion, a token or a certificate body.
  SSO_CONNECTION_UPDATED: "SSO_CONNECTION_UPDATED",
  // A staff user created on first sign-in (just-in-time provisioning is off by default).
  SSO_USER_PROVISIONED: "SSO_USER_PROVISIONED",
  // A staff user's role changed to match the identity provider's group mapping.
  SSO_ROLE_SYNCED: "SSO_ROLE_SYNCED",
  // The provider's stable subject was bound to a staff user (first sign-in); newValue holds the subject, never a token.
  SSO_IDENTITY_LINKED: "SSO_IDENTITY_LINKED",
  // A successful SSO sign-in; newValue records whether the provider reported MFA (information only) and the session lifetime.
  SSO_SIGN_IN_SUCCEEDED: "SSO_SIGN_IN_SUCCEEDED",
  // A refused SSO sign-in that named a real staff user (the reason is in newValue).
  SSO_SIGN_IN_REFUSED: "SSO_SIGN_IN_REFUSED",
  // A Super Admin signed in with password and a TOTP code while the lender had password sign-in turned off.
  SSO_PASSWORD_BREAK_GLASS: "SSO_PASSWORD_BREAK_GLASS",
  OAUTH_CLIENT_CREATED: "OAUTH_CLIENT_CREATED",
  OAUTH_CLIENT_REVOKED: "OAUTH_CLIENT_REVOKED",
})
