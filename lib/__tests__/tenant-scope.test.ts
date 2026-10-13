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
      "TaxInvoice",
      "CreditNote",
      "VatConfig",
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
