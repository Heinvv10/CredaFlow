-- Declaration receipts are tenant-scoped evidence, like SigningOtpChallenge.
-- Add enforcement without changing or removing any existing signed receipt.
ALTER TABLE "AgreementDeclarationAcceptance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgreementDeclarationAcceptance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AgreementDeclarationAcceptance"
  USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant())
  WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
