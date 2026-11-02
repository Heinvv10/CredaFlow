/**
 * Each two-person control asks the shared rule (./account-control.ts) about the right people, and stops on its answer before writing. The rule
 * itself runs on real rows in account-control.integration.test.ts; here only its answer is staged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  refusal: vi.fn(async (_db: unknown, _input: { tenantId: string; makerIds: ReadonlyArray<string | null | undefined>; checkerId: string }): Promise<string | null> => "Two people"),
  rows: {} as Record<string, unknown>,
  writes: [] as string[],
}))
vi.mock("./account-control", () => ({ accountControlRefusal: h.refusal }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/prisma", () => {
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async () => {
      if (/^(update|create|delete|upsert)/.test(method)) { h.writes.push(`${name}.${method}`); return { count: 1 } }
      if (method === "aggregate") return { _max: { amountCents: 0 } }
      if (method === "findMany") return []
      return h.rows[name] ?? null
    },
  })
  const tx: Record<string, unknown> = new Proxy({}, {
    get: (_t, key: string) => {
      if (key === "$queryRaw") return async () => (h.rows.$queryRaw as unknown[]) ?? [{ id: "locked", active: true }]
      if (key === "$executeRaw") return async () => 1
      if (key === "$transaction") return async (fn: (t: unknown) => unknown) => fn(tx)
      return model(key)
    },
  })
  return { prisma: tx }
})
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAuditStrict: vi.fn(async () => undefined) }))

import { approveMaintenanceClaim } from "@/lib/asset-finance/maintenance-claims"
import { confirmContactIdentity } from "@/lib/contact/identity-confirmation"
import { decideMeterReadingVoid } from "@/lib/asset-finance/meter-void"
import { approveSurplusAccount } from "@/lib/asset-finance/nca-surplus-account"
import { approvePayout } from "@/lib/asset-finance/payout"
import { decideRecoveryCost } from "@/lib/asset-finance/recovery-costs"
import { approveRefund, releaseRefund } from "@/lib/asset-finance/recovery-refund"
import { approveSale } from "@/lib/asset-finance/recovery-sale"
import { decideSupplierBankAccount } from "@/lib/asset-finance/supplier-bank-decision"
import { approvePayableRun } from "@/lib/dealer/payable-runs"
import { decideDealerBankAccount } from "@/lib/dealer/staff-bank-accounts"
import { resolveProviderConflict } from "@/lib/payouts/conflicts"
import { decideDisbursementReversal } from "@/lib/payouts/reversal"
import { decidePayoutRetry } from "@/lib/payouts/retry"
import { prisma } from "@/lib/prisma"
import { confirmTheftReport } from "@/lib/telematics/theft-reports"
import { publishGuide } from "@/lib/valuation-guides/guide-store"

const tx = prisma as never
const tenantId = "t1"
const recoveryActor = { tenantId, userId: "checker" }
const staff = { id: "checker", email: "c@test.invalid" }
const moneyDecision = { tenantId, approve: true, note: "Decided after a look", actor: staff }

interface Case { name: string; rows: Record<string, unknown>; run: () => Promise<unknown>; makers: Array<string | null> }
const CASES: Case[] = [
  { name: "asset-finance payout", rows: { payout: { id: "p", status: "PENDING_APPROVAL", createdById: "maker", amountCents: 1, deal: { applicationId: "app" } } }, makers: ["maker"], run: () => approvePayout({ tenantId, userId: "checker" } as never, "deal") },
  { name: "supplier bank account", rows: { supplierBankAccount: { id: "a", supplierId: "s", status: "PENDING", requestedById: "maker" } }, makers: ["maker"], run: () => decideSupplierBankAccount(tx, { tenantId, supplierId: "s", accountId: "a", decision: "APPROVE", note: "n", decider: { id: "checker" } } as never) },
  { name: "dealer bank account", rows: { dealerBankAccount: { id: "a", dealerId: "d", status: "PENDING", requestedById: "maker" } }, makers: ["maker"], run: () => decideDealerBankAccount(tx, { tenantId, accountId: "a", decision: "APPROVE", note: "n", decider: { id: "checker" } } as never) },
  { name: "dealer payable run", rows: { $queryRaw: [{ id: "r", dealerId: "d", status: "PENDING_APPROVAL", createdById: "maker", bankAccountId: "b", totalVatCents: 0 }] }, makers: ["maker"], run: () => approvePayableRun({ tenantId, userId: "checker", userEmail: "c@test.invalid" } as never, "r") },
  { name: "maintenance claim (second approver)", rows: { $queryRaw: [{ id: "c" }], maintenanceClaim: { id: "c", status: "SUBMITTED", amountExclVatCents: 1, submittedById: "maker", firstApprovedById: "first", fundId: "f", fund: { settledAt: null } } }, makers: ["maker", "first"], run: () => approveMaintenanceClaim(tx, { tenantId, userId: "checker" } as never, "c") },
  { name: "meter reading void", rows: { assetMeterReadingVoid: { id: "v", status: "PENDING", requestedById: "maker", readingId: "r", reason: "typo" } }, makers: ["maker"], run: () => decideMeterReadingVoid(tx, { tenantId, userId: "checker" } as never, { loanId: "l", voidId: "v", decision: "APPROVE" }) },
  { name: "recovery cost", rows: { recoveryCost: { status: "PENDING", recordedById: "maker", type: "TOW", grossCents: 1, treatment: "LENDER_ABSORBED" } }, makers: ["maker"], run: () => decideRecoveryCost(recoveryActor, "r", "c", "APPROVED") },
  { name: "remarketing sale", rows: { remarketingSale: { id: "s", status: "PENDING_APPROVAL", createdById: "maker", valuationId: "v", selfValued: false, belowValuation: true, relatedPartyMatch: false, buyerName: "B", buyerIdentifier: "B1", recoveryId: "r", approvedById: null }, recovery: { assetId: "a" }, assetValuation: { source: "ASSESSOR", valuedOn: new Date(), createdById: "valuer" } }, makers: ["maker"], run: () => approveSale(recoveryActor, "r", "s") },
  { name: "recovery refund approval", rows: { recoveryRefund: { id: "f", status: "PENDING_APPROVAL", createdById: "maker", approvedById: null, amountCents: 1 } }, makers: ["maker"], run: () => approveRefund(recoveryActor, "r") },
  { name: "recovery refund release", rows: { recoveryRefund: { id: "f", status: "APPROVED", createdById: "maker", approvedById: "first", amountCents: 1 } }, makers: ["maker", "first"], run: () => releaseRefund(recoveryActor, "r") },
  { name: "NCA surplus account verification", rows: { ncaSurplusAccount: { id: "s", createdById: "maker", approvedById: null, releaseAuthorisedById: null } }, makers: ["maker"], run: () => approveSurplusAccount(recoveryActor, "l", "approve") },
  { name: "NCA surplus release authorisation", rows: { ncaSurplusAccount: { id: "s", createdById: "maker", approvedById: "first", releaseAuthorisedById: null } }, makers: ["maker", "first"], run: () => approveSurplusAccount(recoveryActor, "l", "authorise") },
  { name: "theft report", rows: { assetTheftReport: { id: "t", recordedById: "maker", confirmedAt: null, endedAt: null, validUntil: new Date("2999-01-01T00:00:00Z") } }, makers: ["maker"], run: () => confirmTheftReport({ tenantId, userId: "checker", role: "ADMIN" } as never, "l", "t") },
  { name: "valuation guide", rows: { $queryRaw: [{ id: "g" }], valuationGuide: { id: "g", status: "DRAFT", uploadedById: "maker", effectiveOn: new Date("2026-01-01T00:00:00Z"), simulated: false, name: "G" } }, makers: ["maker"], run: () => publishGuide({ tenantId, userId: "checker" } as never, "g") },
  { name: "payout retry", rows: { disbursementPayout: { id: "p", status: "AWAITING_APPROVAL", loanId: "l", requestedById: "maker", disbursedById: "payer" }, loan: { status: "ACTIVE" } }, makers: ["maker", "payer"], run: () => decidePayoutRetry(tx, { ...moneyDecision, payoutId: "p" }) },
  { name: "disbursement reversal", rows: { disbursementReversal: { id: "r", status: "REQUESTED", loanId: "l", requestedById: "maker" }, disbursementPayout: { disbursedById: "payer" } }, makers: ["maker", "payer"], run: () => decideDisbursementReversal(tx, { ...moneyDecision, reversalId: "r" }) },
  { name: "confirming a staff-set address", rows: { contactIdentity: { id: "i", channel: "EMAIL", value: "a@test.invalid", setByStaffUserId: "maker" } }, makers: ["maker"], run: () => confirmContactIdentity({ tenantId, clientId: "c", identityId: "i", by: { id: "checker", email: "checker@test.invalid", note: "Called the borrower back." } }) },
  { name: "provider conflict", rows: {}, makers: ["payer", "maker", "first"], run: () => resolveProviderConflict(tx, { tenantId, outcome: "not_paid", note: "Checked with the bank", paidAt: null, actor: staff, payout: { id: "p", providerConflictAt: new Date(), conflictResolvedAt: null, providerConflictState: "PAID", disbursedById: "payer", createdById: "maker", approvedById: "first" } } as never) },
]

describe("every two-person control stops on the two-people rule", () => {
  beforeEach(() => {
    h.refusal.mockClear()
    h.writes.length = 0
    for (const key of Object.keys(h.rows)) delete h.rows[key]
  })

  it.each(CASES)("$name", async ({ rows, run, makers }) => {
    Object.assign(h.rows, rows)
    const outcome = await run().catch((error: unknown) => error)
    expect(h.refusal, String(outcome)).toHaveBeenCalledTimes(1)
    expect(h.refusal.mock.calls[0][1]).toMatchObject({ tenantId, makerIds: makers, checkerId: "checker" })
    expect(JSON.stringify(outcome, Object.getOwnPropertyNames(outcome ?? {}))).toContain("Two people")
    expect(h.writes).toEqual([])
  })
})
