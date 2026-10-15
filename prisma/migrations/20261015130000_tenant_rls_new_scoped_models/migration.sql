-- Row-level security for the tenant-scoped models main added after
-- 20261014130000_tenant_rls (W4 screening/FIC, W8 lender API and webhooks, W3
-- signing OTP, asset-finance leases). Same policy as there: every model in
-- TENANT_SCOPED_MODELS carries one (pinned by the RUN_TENANT_ISOLATION_IT
-- catalog test). The policies bind nothing until the application connects as
-- a role RLS binds (docs/ARCHITECTURE.md, RLS activation checklist).
--
-- Not covered (tenantId present, outside TENANT_SCOPED_MODELS): ScreeningBlock,
-- ApiRequestLog (nullable tenantId) and the other tables 20261014130000_tenant_rls
-- lists.

ALTER TABLE "ScreeningCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScreeningCheck" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ScreeningCheck" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CashThresholdReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashThresholdReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CashThresholdReport" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "SuspiciousReportCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SuspiciousReportCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SuspiciousReportCase" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "SuspiciousReportAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SuspiciousReportAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SuspiciousReportAccess" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "RmcpDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RmcpDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RmcpDocument" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApiKey" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "WebhookEndpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEndpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "WebhookEndpoint" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "WebhookEvent" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "WebhookDelivery" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "SigningOtpChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SigningOtpChallenge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SigningOtpChallenge" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LeaseRental" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeaseRental" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LeaseRental" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
