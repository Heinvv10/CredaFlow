/**
 * An in-memory DisbursementPayout table for the dispatch/resolve unit tests.
 * It applies status-pinned updateMany the way Postgres does (one writer wins)
 * and checks every transition against lib/payouts/state.ts. The real
 * trigger is exercised by payouts.integration.test.ts.
 */
import type { DisbursementPayout } from "@prisma/client"
import { canTransition, type PayoutStatus } from "./state"
import type { PayoutDb } from "./dispatch"

export function payoutRow(overrides: Partial<DisbursementPayout> = {}): DisbursementPayout {
  return {
    id: "po-1", tenantId: "t-1", applicationId: "app-1", loanId: "loan-1", provider: "simulated",
    idempotencyKey: "disburse:app-1", amountCents: 150_000, reference: "LN-1",
    accountHolder: "Test Person", bankName: "FNB", branchCode: "250655", accountNumber: "62000001234", accountType: "SAVINGS",
    status: "PENDING", simulated: false, providerReference: null, failureReason: null,
    submittedAt: null, resolvedAt: null, resolvedById: null, resolutionNote: null,
    attempt: 1, retryOfId: null, disbursedById: "u-disburser", requestedById: null, approvedById: null, approvedAt: null,
    paidAt: null, returnedAt: null, providerConflictState: null, providerConflictAt: null, providerConflictDetail: null,
    conflictResolvedById: null, conflictResolvedAt: null, conflictResolutionNote: null,
    createdById: "u-disburser", createdAt: new Date("2026-10-01T08:00:00Z"), updatedAt: new Date("2026-10-01T08:00:00Z"),
    ...overrides,
  }
}

/** `engineOn` is TenantConfig.payoutsEngineEnabled for the tenant. */
export function fakePayoutDb(rows: DisbursementPayout[], engineOn = true) {
  const audits: Array<{ action: string; entityId: string | null; oldValue: unknown; newValue: unknown }> = []
  const matches = (row: DisbursementPayout, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v)
  const table = {
    // Yields before answering, so concurrent callers all read before any writes (the race a claim must survive).
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return rows.find((r) => matches(r, where)) ?? null
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<DisbursementPayout> }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const hit = rows.filter((r) => matches(r, where))
      for (const row of hit) {
        if (data.status && data.status !== row.status && !canTransition(row.status as PayoutStatus, data.status as PayoutStatus)) {
          throw new Error(`Payout guard: ${row.status} -> ${data.status} is not allowed`)
        }
        Object.assign(row, data)
      }
      return { count: hit.length }
    },
  }
  const auditLog = {
    create: async ({ data }: { data: { action: string; entityId: string | null; oldValue: unknown; newValue: unknown } }) => {
      audits.push(data)
      return data
    },
  }
  const tenantConfig = { findUnique: async () => ({ payoutsEngineEnabled: engineOn }) }
  const loan = { findFirst: async () => ({ status: "ACTIVE" }) }
  const db = {
    disbursementPayout: table,
    auditLog,
    tenantConfig,
    loan,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ disbursementPayout: table, auditLog, $queryRaw: async () => [{ status: "ACTIVE" }] }),
  }
  return { db: db as unknown as PayoutDb, rows, audits }
}
