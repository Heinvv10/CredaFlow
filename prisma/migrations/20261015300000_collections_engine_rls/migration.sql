-- Row-level security for the collections engine's tenant-scoped models (W2),
-- added after 20261015130000_tenant_rls_new_scoped_models. Same policy as
-- there: every model in TENANT_SCOPED_MODELS carries one (pinned by the
-- RUN_TENANT_ISOLATION_IT catalog test). The policies bind nothing until the
-- application connects as a role RLS binds (docs/ARCHITECTURE.md, RLS
-- activation checklist).

ALTER TABLE "DebitMandate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DebitMandate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DebitMandate" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CollectionBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CollectionBatch" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CollectionInstruction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionInstruction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CollectionInstruction" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CollectionResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionResult" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CollectionResult" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
