/**
 * Helpers of the commission edge suites (edge-commission, edge-clawback
 * integration tests) over one dealer fixture: fresh dealers so rates do not
 * interact, deals booked through ./dealer-booking.integration-fixture.ts, and
 * history writes with triggers off. Not a test file.
 */
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { insertDealer, insertDealerUser, lit, newId, type DealerFixture } from "./dealer.integration-fixture"
import { approve, book, captureForDealer, commissionLines, dealerDeal } from "./dealer-booking.integration-fixture"

export type EdgeDealer = { dealerId: string; userId: string }

export function edgeCommissionHelpers(fixture: () => DealerFixture) {
  /** A fresh dealer (so rates do not interact) and its one user. */
  function freshDealer(vat = false): EdgeDealer {
    const fx = fixture()
    const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Edge ${newId("n")}`, vatNumber: vat ? "4000000123" : null })
    const userId = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_ADMIN", byUser: fx.adminA })
    return { dealerId, userId }
  }
  const draftDeal = (d: EdgeDealer, baseCents?: number) =>
    dealerDeal(fixture(), { dealerId: d.dealerId, dealerUserId: d.userId, ...captureForDealer(fixture(), d.dealerId), baseCents })
  /** book() then the lines. */
  function bookWith(d: EdgeDealer, baseCents?: number, opts?: { maturity?: string }) {
    const { dealId } = draftDeal(d, baseCents)
    approve(fixture(), dealId)
    const loanId = book(fixture(), dealId, opts)
    return { dealId, loanId }
  }
  return {
    freshDealer, draftDeal, bookWith,
    snap: (dealId: string) =>
      sql(`SELECT "dealerCommissionSource", "dealerCommissionBps", "dealerCommissionFlatCents", "dealerCommissionBaseCents", "dealerCommissionRateId" IS NULL
        FROM "AssetFinanceDeal" WHERE "id" = ${lit(dealId)}`),
    lines: (dealId: string) => commissionLines(dealId, `"kind", "netCents", "vatCents", "grossCents"`),
    cancel: () => `"status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP, "cancelledById" = ${lit(fixture().officer)}, "cancelReason" = 'Synthetic: edge test cancel'`,
    loanStatus: (loanId: string, status: string) => sql(`UPDATE "Loan" SET "status" = '${status}' WHERE "id" = ${lit(loanId)}`),
    setMonths: (months: number) => sql(`UPDATE "TenantConfig" SET "dealerCommissionClawbackMonths" = ${months} WHERE "tenantId" = ${lit(fixture().tenantId)}`),
    earnedAt: (dealId: string, expr: string) =>
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE "DealerCommissionLine" SET "effectiveOn" = ${expr} WHERE "dealId" = ${lit(dealId)} AND "kind" = 'EARNED'; COMMIT;`),
    reversalApproved: (loanId: string) => {
      const fx = fixture()
      sql(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO "DisbursementReversal" ("id", "tenantId", "loanId", "status", "reason", "requestedById", "decidedById", "decidedAt")
        VALUES ('${newId("dr")}', ${lit(fx.tenantId)}, ${lit(loanId)}, 'APPROVED', 'Synthetic', ${lit(fx.officer)}, ${lit(fx.adminB)}, CURRENT_TIMESTAMP); COMMIT;`)
    },
  }
}
