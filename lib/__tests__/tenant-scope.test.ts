import { describe, it, expect } from "vitest"
import {
  runWithTenant,
  withoutTenantScope,
  getCurrentTenantId,
  isAdminScope,
  TenantScopeError,
  TENANT_SCOPED_MODELS,
} from "../tenant-scope"

describe("tenant-scope — ALS primitives", () => {
  it("getCurrentTenantId returns null when no context is set", () => {
    expect(getCurrentTenantId()).toBeNull()
  })

  it("runWithTenant exposes the tenantId inside the callback", async () => {
    const observed = await runWithTenant("tenant-A", async () => getCurrentTenantId())
    expect(observed).toBe("tenant-A")
  })

  it("getCurrentTenantId returns null after runWithTenant exits", async () => {
    await runWithTenant("tenant-A", async () => getCurrentTenantId())
    expect(getCurrentTenantId()).toBeNull()
  })

  it("withoutTenantScope wraps the callback in an admin context (tenantId is null)", async () => {
    const observed = await withoutTenantScope(async () => getCurrentTenantId())
    expect(observed).toBeNull()
  })

  it("withoutTenantScope nested inside runWithTenant blocks visibility of the outer tenant", async () => {
    const observed = await runWithTenant("tenant-A", () =>
      withoutTenantScope(async () => getCurrentTenantId())
    )
    expect(observed).toBeNull()
  })

  // Snapshot of the canonical tenant-scoped model set. Adding or removing a
  // model in lib/tenant-scope.ts requires updating this list — that is the
  // intent. A drift here is a security-relevant change that deserves explicit
  // human review (and an audit trail in git history).
  it("TENANT_SCOPED_MODELS matches the canonical set of tenant-scoped Prisma models", () => {
    expect(TENANT_SCOPED_MODELS).toEqual([
      // R-08e — branch (required tenantId, compound unique on (tenantId, code))
      "Branch",
      // Phase 1 — loan core
      "Client", "Loan", "LoanApplication",
      "Payment", "RepaymentSchedule", "LoanProduct",
      // Phase 2 — collections + documents
      "PaymentArrangement", "ClientDocument", "LoanNote",
      // Phase 3+ — comms, compliance, bureau, complaints, POPIA, auth, insurance
      "NotificationLog", "ComplianceRecord", "CreditBureauCheck",
      "Complaint", "DataSubjectRequest", "LoginLog",
      "Insurer", "CoiDeclaration", "TcfOutcome",
      // Insurance flow
      "InsuranceProduct",
      // Phase 9 CRM + helpdesk. WebhookSignatureFailure
      // is excluded since its tenantId is nullable.
      "Contact", "ContactIdentity", "ContactConsent",
      "ContactMerge", "Conversation", "Message",
      // Referral agents — non-null tenantId.
      "ReferralAgent", "ReferralCode",
      "ReferralEvent",
      // Document Template System (Task 5). DocumentTemplateVersion is scoped
      // transitively via its template relation and is NOT added.
      "DocumentTemplate",
      // Phase 7 collection engine — non-null tenantId; lib/avs.ts passes
      // explicit tenantId on create and guards cross-tenant on read.
      "AvsCheck",
      // In-app bell items — non-null tenantId. Written both inside a
      // request (withTenantContext's ALS frame) and by the lead-task-reminder
      // cron, which has NO frame and therefore passes an explicit tenantId on
      // every call; the rewriter requires one or the other.
      "Notification",
      // Phase 3 @mentions on internal notes (Task 8) — non-null tenantId,
      // written inside request handlers' tenant frame alongside the Message
      // it tags.
      "MessageMention",
      // Derived default charges — non-null tenantId, always passed explicitly.
      "LoanCharge",
      // Bureau data submission ledger — non-null tenantId, always passed explicitly.
      "BureauSubmission",
      "BureauSubmissionRecord",
      "BureauAdverseConfirmation",
      // POPIA security-compromise register — non-null tenantId, passed
      // explicitly by its routes and page.
      "BreachLog",
      // Insurance book + cross-sell — non-null tenantId. Routes run in a
      // tenant frame; pages, crons and bindQuote pass the tenant explicitly.
      "InsurancePolicy",
      "InsuranceClaim",
      "PremiumPayment",
      "CrossSellOpportunity",
      // Credit checks v1 — non-null tenantId, passed explicitly because the
      // statement read runs after its upload request has returned.
      "StatementAnalysis",
      "ApplicationCheckFlag",
      "BusinessEntity",
      "EntityRelationship",
      "NcaRegimeOverride",
      // Asset-finance rates and VAT documents — non-null tenantId, passed
      // explicitly on every query (the repricing cron has no frame). VatRate is
      // national and TaxInvoiceLine is scoped through its invoice: neither is listed.
      "ReferenceRate",
      "ContractRate",
      "AssetFinanceRateNotice", "AssetFinanceRateCorrection",
      "TaxInvoice",
      "CreditNote",
      "VatConfig",
      "EntityDocument",
      "FinancedAsset",
      "AssetValuation",
      "Supplier",
      "SupplierBankAccount",
      "AssetFinanceDeal",
      "EntityFinancials",
      // Deal signing and payout (lib/asset-finance/signing-*.ts, payout*.ts).
      // Non-null tenantId, passed explicitly on every query; the seed runs
      // inside runWithTenant (prisma/seed/asset-finance.ts).
      "DealSigner", "SuretyConsent",
      "PayoutChecklistItem",
      "Payout",
      // Dual-approval KYC override requests — non-null tenantId.
      "KycOverrideRequest",
      // Lender-granted operator support access (lib/operator/) — non-null tenantId.
      "TenantSupportGrant",
      // Client-notified payments awaiting reconciliation (lib/payments/payment-notifications.ts) — non-null tenantId.
      "PaymentNotification",
      // PEP / sanctions screening and FIC registers — non-null tenantId.
      "ScreeningCheck",
      "CashThresholdReport",
      "SuspiciousReportCase",
      "SuspiciousReportAccess",
      "RmcpDocument",
      // Lender API keys and outbound webhooks — non-null tenantId. The key
      // lookup by prefix and the webhook cron's cross-tenant scans run in
      // withoutTenantScope; ApiRequestLog has a nullable tenantId and is not listed.
      "ApiKey",
      "WebhookEndpoint",
      "WebhookEvent",
      "WebhookDelivery",
      // Signing OTP challenges — non-null tenantId.
      "SigningOtpChallenge",
      // Collections engine (lib/collections-engine). Non-null tenantId, passed
      // explicitly on every query: the crons run outside a request frame.
      "DebitMandate",
      "CollectionBatch",
      "CollectionInstruction",
      "CollectionResult",
      // Operating and full-maintenance lease rentals (slice 3) — non-null tenantId.
      "LeaseRental",
      // Recovery and remarketing (slice 4a) — non-null tenantId.
      "CommercialCancellation",
      "LegalMatter",
      "LegalMatterStep",
      "Recovery",
      "RecoveryCost",
      "RemarketingSale",
      "RecoveryVatEvent",
      "RecoveryRefund",
      // Daily arrears history for the NCR return — non-null tenantId; the
      // nightly cron writes inside runWithTenant.
      "LoanArrearsSnapshot",
      "ArrearsSnapshotRun",
      // Append-only electronic declaration receipts: required tenant/application binding.
      "AgreementDeclarationAcceptance",
      // Statement AI (lib/statement-ai) — non-null tenantId, passed explicitly:
      // the worker runs after its request has returned.
      "StatementAiOutput",
      "StatementAiUsage",
      // Lender-template provenance of issued asset-finance documents — non-null tenantId.
      "AssetDocumentIssuance",
      // Dealer/broker portal and commission (slice 5 part A) — non-null tenantId.
      "Dealer",
      "DealerUser",
      "DealerCommissionRate",
      "DealerCommissionLine",
      "DealerPayableRun",
      "DealerPayableRunLine",
      "DealerBankAccount",
      "DealerConsentAttestation",
      "DealerDocumentRequest",
      // Tracker/telematics (slice 5 part B) — non-null tenantId.
      "TrackerDevice",
      "TelematicsEvent",
      "TelematicsPosition",
      "TelematicsHeldReading",
      "TelematicsAlert",
      "TelematicsPositionAccess",
      // Append-only decision log (lib/learning-loop) — non-null tenantId, passed explicitly.
      "CreditDecisionRecord",
      // Outcomes derived from it nightly (lib/learning-loop/outcomes) — non-null tenantId, passed explicitly.
      "DecisionOutcome",
      // Valuation guides (slice 5 part C) — non-null tenantId.
      "ValuationGuide",
      "ValuationGuideRow",
      // Dealer draft purge tombstone (SLICE5-FOLLOWUPS.md part D).
      "DealerDealPurge",
      "DealerPurgePendingFile",
      // Telematics follow-ups (SLICE5-FOLLOWUPS.md part T).
      "AssetTheftReport",
      "AssetMeterReadingVoid",
      "TrackerClosure",
      "AuditPolicy",
      "AuditSiemOutbox",
      "AuditPolicyRevision",
      "AuditSiemDelivery",
      "AuditSiemLease",
      // IFRS 9 staging, ECL and suspension (lib/ifrs9) — non-null tenantId; runs and the cron write inside runWithTenant.
      "Ifrs9Config",
      "Ifrs9EclParameter",
      "Ifrs9SicrFlag",
      "Ifrs9Run",
      "Ifrs9LoanSnapshot",
      // Enterprise sign-in and API OAuth (lib/sso, lib/lender-api/oauth) — non-null tenantId.
      "SsoConnection",
      "OauthClient",
      "SsoIdentity",
      "NcaSurplusAccount",
      "NcaSurplusDetermination",
      "NcaSurplusRemittance",
    ])
  })

  it("TenantScopeError is throwable with model + operation metadata", () => {
    const err = new TenantScopeError({
      reason: "missing-context",
      model: "Loan",
      operation: "findMany",
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("Loan")
    expect(err.message).toContain("findMany")
    expect(err.reason).toBe("missing-context")
  })

  it("isAdminScope returns true inside withoutTenantScope", async () => {
    const observed = await withoutTenantScope(async () => isAdminScope())
    expect(observed).toBe(true)
  })

  it("isAdminScope returns false inside runWithTenant", async () => {
    const observed = await runWithTenant("tenant-A", async () => isAdminScope())
    expect(observed).toBe(false)
  })

  it("TenantScopeError stores expected/found on cross-tenant-mismatch", () => {
    const err = new TenantScopeError({
      reason: "cross-tenant-mismatch",
      model: "Loan",
      operation: "findMany",
      expected: "tenant-A",
      found: "tenant-B",
    })
    expect(err.expected).toBe("tenant-A")
    expect(err.found).toBe("tenant-B")
  })
})
