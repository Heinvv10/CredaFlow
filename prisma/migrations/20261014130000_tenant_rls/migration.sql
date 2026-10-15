-- Postgres row-level security as a backstop to lib/tenant-scope.ts (W0).
--
-- lib/tenant-rls.ts writes two transaction-local settings (set_config(…, true),
-- never a session SET: Prisma pools connections) on every query and every
-- transaction that runs inside a tenant-scope ALS frame:
--
--   app.tenant_id   the frame's tenant (runWithTenant / withTenantContext)
--   app.rls_bypass  'on' in an explicit system frame (withoutTenantScope)
--
-- A row of a covered table is visible and writable when
--   - app.rls_bypass is 'on' (system context), or
--   - its tenant is app.tenant_id, or
--   - no tenant is set and app.rls_strict is not 'on'.
--
-- The last clause keeps code that has no ALS frame yet working (most Server
-- Component pages, some API routes and crons pass where.tenantId by hand).
-- Strict mode — no context means no rows — is one statement once every entry
-- point runs in a frame and data migrations set the bypass first:
--   ALTER DATABASE <db> SET app.rls_strict = 'on';
--
-- FORCE ROW LEVEL SECURITY binds the table owner, which the application
-- connects as. Nothing binds a superuser or a BYPASSRLS role: the application
-- must connect as neither for these policies to hold.
--
-- Foreign-key checks and cascades bypass RLS (Postgres runs them as the
-- owner without policies), so references still resolve across the filter.
--
-- Not covered yet (tenantId present, no policy): AdvisorCommission, AgentTask,
-- AssetFinanceAffordabilityAssessment, AttorneyFirm, AuditLog (nullable),
-- AutomationLog, AutomationPause, AutomationRule, BankStatementImport,
-- BankTransaction, CannedReply, CommsSettings, ConsentRecord, CrmActivity,
-- EmailConfig, EmailLog, InsuranceAdviceRecord, InsuranceEligibilityRule,
-- InsuranceRateTable, IntegrationConfig, IntegrationLog, ManualProgress,
-- MessageTemplate, NotificationThrottle, TenantConfig, User (nullable),
-- WebhookSignatureFailure (nullable), WebsiteChatHandoff; and the children
-- without tenantId outside the borrower core.

CREATE OR REPLACE FUNCTION public.cf_rls_tenant()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT nullif(current_setting('app.tenant_id', true), '')
$function$;

CREATE OR REPLACE FUNCTION public.cf_rls_unrestricted()
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on'
      OR (public.cf_rls_tenant() IS NULL
          AND coalesce(current_setting('app.rls_strict', true), '') <> 'on')
$function$;

-- ── Tables with their own tenantId ──────────────────────────────────────────

ALTER TABLE "Branch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Branch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Branch" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Client" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Client" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Loan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Loan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Loan" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LoanApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanApplication" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanApplication" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Payment" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "RepaymentSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepaymentSchedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RepaymentSchedule" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LoanProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanProduct" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanProduct" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "PaymentArrangement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentArrangement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PaymentArrangement" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ClientDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ClientDocument" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LoanNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanNote" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "NotificationLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "NotificationLog" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ComplianceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ComplianceRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ComplianceRecord" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CreditBureauCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditBureauCheck" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CreditBureauCheck" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Complaint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Complaint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Complaint" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DataSubjectRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataSubjectRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DataSubjectRequest" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LoginLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoginLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoginLog" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Insurer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Insurer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Insurer" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CoiDeclaration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoiDeclaration" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CoiDeclaration" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "TcfOutcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TcfOutcome" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TcfOutcome" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "InsuranceProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsuranceProduct" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InsuranceProduct" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Contact" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ContactIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactIdentity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ContactIdentity" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ContactConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactConsent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ContactConsent" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ContactMerge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContactMerge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ContactMerge" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Conversation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Message" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ReferralAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferralAgent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ReferralAgent" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ReferralCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferralCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ReferralCode" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ReferralEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferralEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ReferralEvent" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DocumentTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DocumentTemplate" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AvsCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AvsCheck" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AvsCheck" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Notification" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "MessageMention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageMention" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "MessageMention" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LoanCharge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanCharge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanCharge" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BureauSubmission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BureauSubmission" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BureauSubmission" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BureauSubmissionRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BureauSubmissionRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BureauSubmissionRecord" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BureauAdverseConfirmation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BureauAdverseConfirmation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BureauAdverseConfirmation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BreachLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BreachLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BreachLog" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "InsurancePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsurancePolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InsurancePolicy" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "InsuranceClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsuranceClaim" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InsuranceClaim" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "PremiumPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PremiumPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PremiumPayment" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CrossSellOpportunity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CrossSellOpportunity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CrossSellOpportunity" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "StatementAnalysis" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StatementAnalysis" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StatementAnalysis" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApplicationCheckFlag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApplicationCheckFlag" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApplicationCheckFlag" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BusinessEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessEntity" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BusinessEntity" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "EntityRelationship" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EntityRelationship" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "EntityRelationship" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "NcaRegimeOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NcaRegimeOverride" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "NcaRegimeOverride" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ReferenceRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReferenceRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ReferenceRate" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ContractRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContractRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ContractRate" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "TaxInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaxInvoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TaxInvoice" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "CreditNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CreditNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CreditNote" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "VatConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VatConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "VatConfig" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "EntityDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EntityDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "EntityDocument" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "FinancedAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancedAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "FinancedAsset" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AssetValuation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetValuation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AssetValuation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Supplier" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "SupplierBankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierBankAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SupplierBankAccount" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AssetFinanceDeal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetFinanceDeal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AssetFinanceDeal" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "EntityFinancials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EntityFinancials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "EntityFinancials" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealSigner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealSigner" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealSigner" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "PayoutChecklistItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayoutChecklistItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PayoutChecklistItem" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Payout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payout" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Payout" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "KycOverrideRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KycOverrideRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "KycOverrideRequest" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "TenantSupportGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSupportGrant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TenantSupportGrant" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "PasqAcknowledgementToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasqAcknowledgementToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PasqAcknowledgementToken" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "SelfieCaptureToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SelfieCaptureToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SelfieCaptureToken" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "SurrenderRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SurrenderRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SurrenderRequest" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "InsuranceQuote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsuranceQuote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InsuranceQuote" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Lead" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Lead" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- ── Children scoped through their parent ────────────────────────────────────

ALTER TABLE "AttorneyReferral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttorneyReferral" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AttorneyReferral" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Loan" p WHERE p."id" = "AttorneyReferral"."loanId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Loan" p WHERE p."id" = "AttorneyReferral"."loanId"));

ALTER TABLE "PaymentPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentPlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PaymentPlan" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Loan" p WHERE p."id" = "PaymentPlan"."loanId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Loan" p WHERE p."id" = "PaymentPlan"."loanId"));

ALTER TABLE "StitchPaymentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StitchPaymentRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "StitchPaymentRequest" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Loan" p WHERE p."id" = "StitchPaymentRequest"."loanId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Loan" p WHERE p."id" = "StitchPaymentRequest"."loanId"));

ALTER TABLE "ClientExpenseBreakdown" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientExpenseBreakdown" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ClientExpenseBreakdown" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Client" p WHERE p."id" = "ClientExpenseBreakdown"."clientId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Client" p WHERE p."id" = "ClientExpenseBreakdown"."clientId"));

ALTER TABLE "ExistingDebtObligation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExistingDebtObligation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ExistingDebtObligation" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Client" p WHERE p."id" = "ExistingDebtObligation"."clientId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Client" p WHERE p."id" = "ExistingDebtObligation"."clientId"));

ALTER TABLE "ClientConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClientConsent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ClientConsent" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Client" p WHERE p."id" = "ClientConsent"."clientId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "Client" p WHERE p."id" = "ClientConsent"."clientId"));

ALTER TABLE "InsuredLife" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsuredLife" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "InsuredLife" USING (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "InsuranceQuote" p WHERE p."id" = "InsuredLife"."quoteId") OR EXISTS (SELECT 1 FROM "InsurancePolicy" p WHERE p."id" = "InsuredLife"."policyId")) WITH CHECK (public.cf_rls_unrestricted() OR EXISTS (SELECT 1 FROM "InsuranceQuote" p WHERE p."id" = "InsuredLife"."quoteId") OR EXISTS (SELECT 1 FROM "InsurancePolicy" p WHERE p."id" = "InsuredLife"."policyId"));
