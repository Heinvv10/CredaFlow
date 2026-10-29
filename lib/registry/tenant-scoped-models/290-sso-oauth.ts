import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Enterprise sign-in and API OAuth (lib/sso, lib/lender-api/oauth). Non-null
  // tenantId. SsoCacheEntry is not tenant data (keys are namespaced by writer).
  // The OAuth token endpoint finds a client by its public id before the lender
  // is known, in withoutTenantScope.
  "SsoConnection",
  "OauthClient",
  "SsoIdentity",
] as const)
