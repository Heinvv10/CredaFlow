import { AsyncLocalStorage } from "node:async_hooks"

export const TENANT_SCOPED_MODELS = [
  "Branch",
  "Client",
  "Loan",
  "LoanApplication",
  "Payment",
  "RepaymentSchedule",
  "LoanProduct",
  "PaymentArrangement",
  "ClientDocument",
  "LoanNote",
  "NotificationLog",
  "ComplianceRecord",
  "CreditBureauCheck",
  "Complaint",
  "DataSubjectRequest",
  "LoginLog",
  "Insurer",
  "CoiDeclaration",
  "TcfOutcome",
  "InsuranceProduct",
  // Phase 9 CRM + helpdesk (S1 step 1a). WebhookSignatureFailure is
  // deliberately excluded — its tenantId is nullable (signature failures may
  // predate tenant resolution at the auth seam) so it cannot be enrolled in
  // the auto-injection rewriter.
  "Contact",
  "ContactIdentity",
  "ContactConsent",
  "ContactMerge",
  "Conversation",
  "Message",
  // Referral agents. All three carry a non-null tenantId; every query site
  // passes an explicit where/data tenantId.
  "ReferralAgent",
  "ReferralCode",
  "ReferralEvent",
  // Document Template System (Task 5). DocumentTemplateVersion is scoped
  // transitively via its `template` relation and is deliberately NOT added
  // here — it has no tenantId column of its own.
  "DocumentTemplate",
  // Phase 7 collection engine. Non-null tenantId; lib/avs.ts also passes an
  // explicit tenantId on create and guards cross-tenant on read.
  "AvsCheck",
  // In-app bell items. Non-null tenantId. Written by request handlers (inside
  // withTenantContext's ALS frame) and by the lead-task-reminder cron, which
  // has no ALS frame and therefore passes an explicit tenantId on every query
  // — the rewriter requires one or the other and throws missing-context
  // otherwise.
  "Notification",
  // Phase 3 @mentions on internal notes (Task 8). Non-null tenantId, written
  // inside request handlers' tenant frame alongside the Message it tags.
  "MessageMention",
  // Derived default charges (lib/loan/charges-sync.ts). Non-null tenantId;
  // every query passes it explicitly because the sync also runs outside a
  // request frame.
  "LoanCharge",
  // Bureau data submission (lib/bureau-submission). Non-null tenantId; every
  // query passes it explicitly because the crons run outside a request frame.
  "BureauSubmission",
  "BureauSubmissionRecord",
  "BureauAdverseConfirmation",
  // POPIA security-compromise register. Non-null tenantId; its routes and
  // page pass it explicitly, so the rewriter is the backstop for a query that
  // forgets to.
  "BreachLog",
  // Insurance book + cross-sell opportunities. Non-null tenantId. Routes run
  // inside withTenantContext's frame; callers outside a request frame pass
  // tenantId explicitly.
  "InsurancePolicy",
  "InsuranceClaim",
  "PremiumPayment",
  "CrossSellOpportunity",
  // Credit checks v1. Non-null tenantId; the statement read also runs after
  // its upload request has returned, so every query passes it explicitly.
  "StatementAnalysis",
  "ApplicationCheckFlag",
  // Asset finance (docs/asset-finance/DESIGN.md). Non-null tenantId; the
  // routes run inside withTenantContext and also pass it explicitly.
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
  "DealSigner",
  "PayoutChecklistItem",
  "Payout",
  "KycOverrideRequest",
  // PEP / sanctions screening and FIC registers (lib/screening, lib/fic).
  // Non-null tenantId; every query passes it explicitly because the screening
  // cron and the submit-time run execute outside a request frame.
  "ScreeningCheck",
  "CashThresholdReport",
  "SuspiciousReportCase",
  "SuspiciousReportAccess",
  "RmcpDocument",
  // Lender API (lib/lender-api). Non-null tenantId. The key lookup by prefix
  // and the webhook cron's cross-tenant scans run in withoutTenantScope;
  // ApiRequestLog (nullable tenantId: a call with an unknown key) is not listed.
  "ApiKey",
  "WebhookEndpoint",
  "WebhookEvent",
  "WebhookDelivery",
  // Operating and full-maintenance leases (slice 3). Non-null tenantId,
  // passed explicitly on every query (the invoice cron has no frame).
  "LeaseRental",
] as const

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number]

type Frame =
  | { kind: "tenant"; tenantId: string }
  | { kind: "admin" }

// One context per process, kept on globalThis: in development lib/prisma.ts
// shares one client across bundles, and its extension must see the frame a
// route opened from its own instance of this module
// (lib/tenant-scope-instances.test.ts).
const globalForTenantScope = globalThis as unknown as { tenantContext?: AsyncLocalStorage<Frame> }
export const tenantContext = (globalForTenantScope.tenantContext ??= new AsyncLocalStorage<Frame>())

export function runWithTenant<T>(
  tenantId: string,
  fn: () => Promise<T>
): Promise<T> {
  return tenantContext.run({ kind: "tenant", tenantId }, fn)
}

export function withoutTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ kind: "admin" }, fn)
}

export function getCurrentTenantId(): string | null {
  const frame = tenantContext.getStore()
  if (!frame) return null
  if (frame.kind === "admin") return null
  return frame.tenantId
}

export function isAdminScope(): boolean {
  return tenantContext.getStore()?.kind === "admin"
}

export type TenantScopeErrorReason =
  | "missing-context"
  | "cross-tenant-mismatch"

type TenantScopeErrorOpts =
  | {
      reason: "missing-context"
      model: string
      operation: string
    }
  | {
      reason: "cross-tenant-mismatch"
      model: string
      operation: string
      expected: string
      found: string
    }

export class TenantScopeError extends Error {
  readonly reason: TenantScopeErrorReason
  readonly model: string
  readonly operation: string
  readonly expected?: string
  readonly found?: string

  constructor(opts: TenantScopeErrorOpts) {
    const detail =
      opts.reason === "cross-tenant-mismatch"
        ? ` (expected tenantId="${opts.expected}", found "${opts.found}")`
        : ""
    super(
      `[tenant-scope] ${opts.reason} on ${opts.model}.${opts.operation}${detail}`
    )
    this.name = "TenantScopeError"
    this.reason = opts.reason
    this.model = opts.model
    this.operation = opts.operation
    if (opts.reason === "cross-tenant-mismatch") {
      this.expected = opts.expected
      this.found = opts.found
    }
  }
}

// Prisma's $extends query signature is too complex to type strictly here
// (each model + operation has its own args/return types). The rewriter
// crosses the boundary between strongly-typed Prisma generated types and
// our enforcement logic, so `any` is appropriate at this seam.
/* eslint-disable @typescript-eslint/no-explicit-any */
type RewriteArgs = {
  model: string
  operation: string
  args: any
  query: (args: any) => Promise<any>
}

const READ_OPS = new Set([
  "findUnique", "findUniqueOrThrow",
  "findFirst", "findFirstOrThrow",
  "findMany", "count", "aggregate", "groupBy",
])
const WHERE_MUTATION_OPS = new Set([
  "update", "updateMany", "delete", "deleteMany",
])
const DATA_CREATE_OPS = new Set(["create", "createMany"])

function isScopedModel(name: string): boolean {
  return (TENANT_SCOPED_MODELS as readonly string[]).includes(name)
}

export function applyTenantScopeExtension() {
  return async function rewrite(p: RewriteArgs) {
    if (!isScopedModel(p.model)) return p.query(p.args)

    const frame = tenantContext.getStore()
    const args = p.args ?? {}

    // admin escape hatch — no enforcement
    if (frame?.kind === "admin") return p.query(args)

    const alsTenant = frame?.kind === "tenant" ? frame.tenantId : null

    // reads + where-mutations (use args.where)
    if (READ_OPS.has(p.operation) || WHERE_MUTATION_OPS.has(p.operation) || p.operation === "upsert") {
      const where = args.where ?? {}
      const explicit = where.tenantId as string | undefined

      if (!alsTenant) {
        if (explicit === undefined) {
          throw new TenantScopeError({
            reason: "missing-context",
            model: p.model,
            operation: p.operation,
          })
        }
        return p.query(args)
      }

      if (explicit !== undefined && explicit !== alsTenant) {
        throw new TenantScopeError({
          reason: "cross-tenant-mismatch",
          model: p.model,
          operation: p.operation,
          expected: alsTenant,
          found: explicit,
        })
      }

      // For upsert, also inject tenantId into create payload if missing
      // (the update payload is bounded by where, but the create payload is
      // a fresh row and must carry tenantId to satisfy the NOT NULL column).
      if (p.operation === "upsert") {
        const create = args.create ?? {}
        if (create.tenantId !== undefined && create.tenantId !== alsTenant) {
          throw new TenantScopeError({
            reason: "cross-tenant-mismatch",
            model: p.model,
            operation: p.operation,
            expected: alsTenant,
            found: create.tenantId,
          })
        }
        const nextArgs: Record<string, unknown> = {
          ...args,
          where: explicit === undefined ? { ...where, tenantId: alsTenant } : where,
          create: create.tenantId === undefined ? { ...create, tenantId: alsTenant } : create,
        }
        return p.query(nextArgs)
      }

      if (explicit === undefined) {
        return p.query({ ...args, where: { ...where, tenantId: alsTenant } })
      }
      return p.query(args)
    }

    // creates (use args.data)
    if (DATA_CREATE_OPS.has(p.operation)) {
      const data = args.data ?? {}
      if (Array.isArray(data)) {
        if (!alsTenant) {
          const allHave = (data as any[]).every((row: any) => row.tenantId !== undefined)
          if (!allHave) {
            throw new TenantScopeError({
              reason: "missing-context",
              model: p.model,
              operation: p.operation,
            })
          }
          return p.query(args)
        }
        const next = (data as any[]).map((row: any) => {
          if (row.tenantId === undefined) return { ...row, tenantId: alsTenant }
          if (row.tenantId !== alsTenant) {
            throw new TenantScopeError({
              reason: "cross-tenant-mismatch",
              model: p.model,
              operation: p.operation,
              expected: alsTenant,
              found: row.tenantId,
            })
          }
          return row
        })
        return p.query({ ...args, data: next })
      }
      // single create
      const explicit = data.tenantId as string | undefined
      if (!alsTenant) {
        if (explicit === undefined) {
          throw new TenantScopeError({
            reason: "missing-context",
            model: p.model,
            operation: p.operation,
          })
        }
        return p.query(args)
      }
      if (explicit === undefined) {
        return p.query({ ...args, data: { ...data, tenantId: alsTenant } })
      }
      if (explicit !== alsTenant) {
        throw new TenantScopeError({
          reason: "cross-tenant-mismatch",
          model: p.model,
          operation: p.operation,
          expected: alsTenant,
          found: explicit,
        })
      }
      return p.query(args)
    }

    return p.query(args)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
