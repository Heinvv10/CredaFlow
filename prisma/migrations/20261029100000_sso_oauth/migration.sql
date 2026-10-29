-- CreateEnum
CREATE TYPE "SsoProtocol" AS ENUM ('OIDC', 'SAML');

-- AlterTable
ALTER TABLE "ApiRequestLog" ADD COLUMN     "oauthClientId" TEXT;

-- CreateTable
CREATE TABLE "SsoConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "protocol" "SsoProtocol" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "oidcIssuer" TEXT,
    "oidcClientId" TEXT,
    "oidcClientSecretSealed" TEXT,
    "oidcScopes" TEXT[],
    "samlEntityId" TEXT,
    "samlIdpEntityId" TEXT,
    "samlIdpSsoUrl" TEXT,
    "samlIdpCert" TEXT,
    "emailClaim" TEXT NOT NULL DEFAULT 'email',
    "groupsClaim" TEXT NOT NULL DEFAULT 'groups',
    "allowedEmailDomains" TEXT[],
    "groupRoleMap" JSONB NOT NULL DEFAULT '{}',
    "jitProvisioning" BOOLEAN NOT NULL DEFAULT false,
    "jitDefaultRole" "UserRole",
    "trustIdpMfa" BOOLEAN NOT NULL DEFAULT false,
    "mfaAcrValues" TEXT[],
    "passwordLoginDisabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoCacheEntry" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoCacheEntry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OauthClient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "requireMtls" BOOLEAN NOT NULL DEFAULT false,
    "mtlsSubjectDn" TEXT,
    "mtlsCertSha256" TEXT,

    CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoConnection_tenantId_key" ON "SsoConnection"("tenantId");

-- CreateIndex
CREATE INDEX "SsoCacheEntry_expiresAt_idx" ON "SsoCacheEntry"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OauthClient_clientId_key" ON "OauthClient"("clientId");

-- CreateIndex
CREATE INDEX "OauthClient_tenantId_createdAt_idx" ON "OauthClient"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OauthClient_tenantId_id_key" ON "OauthClient"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ApiRequestLog_oauthClientId_createdAt_idx" ON "ApiRequestLog"("oauthClientId", "createdAt");

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "OauthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written enforcement ────────────────────────────────────────────────
-- New tables only: nothing here rejects a write the running code makes today.

-- A connection carries the fields its protocol needs.
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_protocol_fields_check" CHECK (
  ("protocol" <> 'OIDC' OR ("oidcIssuer" IS NOT NULL AND "oidcClientId" IS NOT NULL AND "oidcClientSecretSealed" IS NOT NULL))
  AND ("protocol" <> 'SAML' OR ("samlEntityId" IS NOT NULL AND "samlIdpEntityId" IS NOT NULL AND "samlIdpSsoUrl" IS NOT NULL AND "samlIdpCert" IS NOT NULL))
);

-- The identity provider can never mint or provision a SUPER_ADMIN or operator
-- user: not as the just-in-time default, and not through a group mapping.
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_jit_role_check" CHECK (
  "jitDefaultRole" IS NULL OR "jitDefaultRole" NOT IN ('SUPER_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_SUPPORT')
);
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_jit_needs_role_check" CHECK (
  "jitProvisioning" = false OR "jitDefaultRole" IS NOT NULL
);
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_group_map_check" CHECK (
  jsonb_typeof("groupRoleMap") = 'object'
  AND NOT jsonb_path_exists("groupRoleMap", '$.* ? (@ == "SUPER_ADMIN" || @ == "OPERATOR_ADMIN" || @ == "OPERATOR_SUPPORT")')
);

-- Password sign-in is turned off only while single sign-on is on.
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_password_off_needs_sso_check" CHECK (
  "passwordLoginDisabled" = false OR "enabled" = true
);

-- Same scope list as ApiKey_scopes_check (20261014150000_lender_api_webhooks): change both together.
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_scopes_check" CHECK (
  cardinality("scopes") > 0
  AND "scopes" <@ ARRAY['clients:read', 'applications:read', 'applications:write', 'loans:read', 'payments:read', 'pii:read']::text[]
);
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_revocation_check" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL));
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_expiry_check" CHECK ("expiresAt" > "createdAt");
-- A client that requires mutual TLS names the certificate it is pinned to.
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_mtls_pin_check" CHECK (
  "requireMtls" = false OR "mtlsSubjectDn" IS NOT NULL OR "mtlsCertSha256" IS NOT NULL
);

-- Row-level security, the policy every model in TENANT_SCOPED_MODELS carries
-- (pinned by the RUN_TENANT_ISOLATION_IT catalog test).
ALTER TABLE "SsoConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SsoConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SsoConnection" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "OauthClient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OauthClient" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "OauthClient" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
