/**
 * Real-Postgres proof of the two row-shape CHECKs, clause by clause (review
 * round 2, R2-T1/R2-T2). The guard triggers refuse most bad rows before a
 * CHECK runs, so each statement here is written with triggers off (as
 * history), leaving the CHECK as the only rule; each runs in a rolled-back
 * transaction.
 *
 *  - DealerCommissionLine_shape: EARNED has no reversal or reason and a
 *    positive net; REVERSED has both and a negative net; gross = net + VAT;
 *    VAT only for a VAT vendor.
 *  - DealerPayableRun_status_shape: each status carries exactly its own
 *    approval, release and cancellation columns; a released run has a
 *    non-blank release reference.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-row-shapes.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { approvedDealerAccount, cleanupDealerFixtureIfCreated, createDealerFixture, lit, newId, TODAY_SQL, type DealerFixture } from "./dealer.integration-fixture"
import { bookedDealerDeal } from "./dealer-booking.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let deal: { dealId: string; loanId: string }
let earnedId: string
let account: string

/** `stmt` with triggers off, rolled back: only CHECKs and keys judge it. */
const history = (stmt: string) => `BEGIN; SET LOCAL session_replication_role = replica; ${stmt}; ROLLBACK;`

type LineOver = { kind?: string; reverses?: string | null; reason?: string | null; net?: number; vat?: number; gross?: number; vendor?: boolean }
function line(over: LineOver = {}, id = newId("dcl")): string {
  const net = over.net ?? 1000
  const vat = over.vat ?? 0
  return `INSERT INTO "DealerCommissionLine" ("id", "tenantId", "dealerId", "dealId", "loanId", "kind", "reversesLineId", "reason", "effectiveOn",
      "baseCents", "bps", "flatCents", "netCents", "vatRate", "vatCents", "grossCents", "dealerVatVendor", "clawbackMonths")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, ${lit(deal.dealId)}, ${lit(deal.loanId)}, '${over.kind ?? "EARNED"}',
      ${lit(over.reverses ?? null)}, ${over.reason ? `'${over.reason}'` : "NULL"}, ${TODAY_SQL}, 100000, 100, 0, ${net}, 0.15, ${vat},
      ${over.gross ?? net + vat}, ${over.vendor ?? false}, 12)`
}
const reversal = (over: LineOver = {}) => line({ kind: "REVERSED", reverses: earnedId, reason: "LOAN_CANCELLED", net: -1000, ...over })

type RunOver = Partial<Record<"status" | "approvedById" | "approvedAt" | "releasedById" | "releasedAt" | "releaseReference" | "cancelledById" | "cancelledAt", string | null>>
function run(over: RunOver): string {
  const v = (key: keyof RunOver) => (over[key] === undefined || over[key] === null ? "NULL" : over[key] as string)
  return `INSERT INTO "DealerPayableRun" ("id", "tenantId", "dealerId", "periodEnd", "bankAccountId", "status", "totalNetCents", "totalVatCents",
      "totalGrossCents", "createdById", "approvedById", "approvedAt", "releasedById", "releasedAt", "releaseReference", "cancelledById", "cancelledAt")
    VALUES (${lit(newId("run"))}, ${lit(fx.tenantId)}, ${lit(fx.dealerA)}, '2026-01-31', ${lit(account)}, '${over.status}', 1000, 0, 1000,
      ${lit(fx.adminA)}, ${v("approvedById")}, ${v("approvedAt")}, ${v("releasedById")}, ${v("releasedAt")}, ${v("releaseReference")},
      ${v("cancelledById")}, ${v("cancelledAt")})`
}

suite.sequential("dealer row-shape CHECKs, clause by clause (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    // No rate in force: the booking writes no line, so these are the deal's only lines.
    deal = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    earnedId = newId("dcl")
    sql(`BEGIN; SET LOCAL session_replication_role = replica; ${line({}, earnedId)}; COMMIT;`)
    account = approvedDealerAccount(fx, fx.dealerA)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  describe("DealerCommissionLine_shape", () => {
    const SHAPE = "DealerCommissionLine_shape"

    it("accepts a well-formed REVERSED line and a vendor's line with VAT", () => {
      sql(history(reversal()))
      sql(history(reversal({ vendor: true, vat: -150 })))
    })

    it("refuses an EARNED line with a reversal, a reason, or a net that is not positive", () => {
      // A second EARNED line would meet the one-per-deal index first: each try replaces the deal's line, rolled back.
      const fresh = (over: LineOver) => `DELETE FROM "DealerCommissionLine" WHERE "id" = ${lit(earnedId)}; ${line(over)}`
      sql(history(fresh({})))
      expectRejected(history(fresh({ reverses: earnedId })), SHAPE)
      expectRejected(history(fresh({ reason: "LOAN_CANCELLED" })), SHAPE)
      expectRejected(history(fresh({ net: 0 })), SHAPE)
      expectRejected(history(fresh({ net: -1000 })), SHAPE)
    })

    it("refuses a REVERSED line without its reversal or reason, or with a net that is not negative", () => {
      expectRejected(history(reversal({ reverses: null })), SHAPE)
      expectRejected(history(reversal({ reason: null })), SHAPE)
      expectRejected(history(reversal({ net: 0 })), SHAPE)
      expectRejected(history(reversal({ net: 1000 })), SHAPE)
    })

    it("refuses a gross that is not net plus VAT, and VAT for a dealer that is not a vendor", () => {
      expectRejected(history(reversal({ gross: -999 })), SHAPE)
      expectRejected(history(reversal({ vendor: true, vat: -150, gross: -1000 })), SHAPE)
      expectRejected(history(reversal({ vendor: false, vat: -150 })), SHAPE)
    })
  })

  describe("DealerPayableRun_status_shape", () => {
    const SHAPE = "DealerPayableRun_status_shape"
    const now = "CURRENT_TIMESTAMP"
    const shapes = () => ({
      approval: { approvedById: lit(fx.adminB), approvedAt: now },
      release: { releasedById: lit(fx.adminB), releasedAt: now, releaseReference: "'TEST-EFT-1'" },
      cancel: { cancelledById: lit(fx.adminB), cancelledAt: now },
    })

    it("accepts each status with exactly its own columns", () => {
      const s = shapes()
      sql(history(run({ status: "PENDING_APPROVAL" })))
      sql(history(run({ status: "APPROVED", ...s.approval })))
      sql(history(run({ status: "RELEASED", ...s.approval, ...s.release })))
      sql(history(run({ status: "CANCELLED", ...s.cancel })))
      sql(history(run({ status: "CANCELLED", ...s.approval, ...s.cancel })))
    })

    it("refuses a pending run with any approval, release or cancellation column", () => {
      const s = shapes()
      for (const extra of [{ approvedById: s.approval.approvedById }, { approvedAt: now }, { releasedAt: now }, { releaseReference: "'X'" }, { cancelledAt: now }]) {
        expectRejected(history(run({ status: "PENDING_APPROVAL", ...extra })), SHAPE)
      }
    })

    it("refuses an approved run missing its approval or carrying a release or cancellation", () => {
      const s = shapes()
      expectRejected(history(run({ status: "APPROVED", approvedById: s.approval.approvedById })), SHAPE)
      expectRejected(history(run({ status: "APPROVED", approvedAt: now })), SHAPE)
      expectRejected(history(run({ status: "APPROVED", ...s.approval, releasedAt: now })), SHAPE)
      expectRejected(history(run({ status: "APPROVED", ...s.approval, cancelledAt: now })), SHAPE)
    })

    it("refuses a released run without its approval, its release, or a non-blank release reference, or with a cancellation", () => {
      const s = shapes()
      expectRejected(history(run({ status: "RELEASED", ...s.release })), SHAPE)
      expectRejected(history(run({ status: "RELEASED", ...s.approval, ...s.release, releasedById: null })), SHAPE)
      expectRejected(history(run({ status: "RELEASED", ...s.approval, ...s.release, releasedAt: null })), SHAPE)
      expectRejected(history(run({ status: "RELEASED", ...s.approval, ...s.release, releaseReference: null })), SHAPE)
      expectRejected(history(run({ status: "RELEASED", ...s.approval, ...s.release, releaseReference: "'   '" })), SHAPE)
      expectRejected(history(run({ status: "RELEASED", ...s.approval, ...s.release, ...s.cancel })), SHAPE)
    })

    it("refuses a cancelled run without its cancellation, with half an approval, or with a release", () => {
      const s = shapes()
      expectRejected(history(run({ status: "CANCELLED", cancelledById: s.cancel.cancelledById })), SHAPE)
      expectRejected(history(run({ status: "CANCELLED", cancelledAt: now })), SHAPE)
      expectRejected(history(run({ status: "CANCELLED", ...s.cancel, approvedAt: now })), SHAPE)
      expectRejected(history(run({ status: "CANCELLED", ...s.cancel, releaseReference: "'X'" })), SHAPE)
    })
  })
})
