/**
 * Dealer deals at the database level for the RUN_ASSET_FINANCE_DEALER_IT
 * suites. A dealer-captured borrower and asset; a deal INSERTed with the
 * dealer columns (every trigger on); SUBMITTED → APPROVED by plain UPDATEs
 * (triggers on: the commission snapshot is the database's); and booking.
 *
 * Booking: the prerequisites a real booking has by then (contract terms,
 * Loan, ContractRate, the confirmed supplier-invoice item and an APPROVED
 * Payout) are written in one transaction with triggers off, as history; the
 * CONTRACTED → BOOKED UPDATE itself runs with every trigger on, so the
 * booking gate checks those rows and the accrual trigger fires exactly as it
 * does under lib/asset-finance/booking.ts. The application is NON_NCA and,
 * at booking, DISBURSED (the Loan commit invariant requires it). The dealer
 * `createDeal` path lands in a later task; this is the DB contract it must meet.
 * Not a test file.
 */
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { lit, newId, TODAY_SQL, type DealerFixture } from "./dealer.integration-fixture"

/**
 * The commission base is the goods advance: the asset's cash price incl. VAT
 * less the deposit and the trade-in (spec deviation 5), never the financed
 * fees. 150 000 020 × 250 bps = 3 750 000.5 cents: half-up rounding is
 * visible.
 */
export const DEALER_DEAL_BASE_CENTS = 150_000_020
/** Financed fees on every fixture deal: the applied amount is the base plus these, so a base read from it is caught. */
export const DEALER_DEAL_FEES_CENTS = 1_000_000
/** The fixture asset's cash price incl. VAT (captureForDealer). */
const ASSET_PRICE_CENTS = 172_500_000

export interface Captured {
  entityId: string
  assetId: string
}

/** A company and an asset captured by `dealerId` (createdByDealerId set). */
export function captureForDealer(fx: DealerFixture, dealerId: string | null): Captured {
  const entityId = newId("ent")
  const assetId = newId("ast")
  const serial = `TEST${assetId.slice(-12).toUpperCase()}`
  sql(`INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "createdByDealerId", "updatedAt")
      VALUES (${lit(entityId)}, ${lit(fx.tenantId)}, 'COMPANY', 'TEST Dealer Client (Pty) Ltd', ${lit(`2099/${entityId.slice(-6)}/07`)}, ${lit(dealerId)}, CURRENT_TIMESTAMP);
    INSERT INTO "FinancedAsset" ("id", "tenantId", "assetClass", "make", "model", "year", "serialNumber", "cashPriceExclVatCents", "vatCents", "createdByDealerId", "updatedAt")
      VALUES (${lit(assetId)}, ${lit(fx.tenantId)}, 'TLB', 'TEST', 'TLB-1', 2025, ${lit(serial)}, 150000000, 22500000, ${lit(dealerId)}, CURRENT_TIMESTAMP)`)
  return { entityId, assetId }
}

export interface DealerDealInput {
  dealerId: string | null
  dealerUserId: string | null
  entityId?: string
  clientId?: string
  assetId: string
  createdById?: string
  /** The goods advance (default DEALER_DEAL_BASE_CENTS); a larger one than the asset's price raises the price (history). */
  baseCents?: number
}

/** The application (triggers off: history) and the deal's INSERT statement (run by the caller). */
export function dealerDealInsert(fx: DealerFixture, input: DealerDealInput): { dealId: string; applicationId: string; insert: string } {
  const dealId = newId("dl")
  const applicationId = newId("app")
  const base = input.baseCents ?? DEALER_DEAL_BASE_CENTS
  const applied = base + DEALER_DEAL_FEES_CENTS
  if (base > ASSET_PRICE_CENTS) {
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE "FinancedAsset" SET "cashPriceExclVatCents" = ${base}, "vatCents" = 0 WHERE "id" = ${lit(input.assetId)}; COMMIT;`)
  }
  const price = Math.max(base, ASSET_PRICE_CENTS)
  // Split what the borrower brings between a deposit and a trade-in, so the base is checked against both.
  const tradeIn = Math.floor((price - base) / 2)
  const deposit = price - base - tradeIn
  const borrower = { client: lit(input.clientId ?? null), entity: lit(input.entityId ?? null) }
  const regime = input.entityId ? `'NON_NCA', 'JURISTIC_OVER_THRESHOLD'` : `'NCA', 'NATURAL_PERSON_NCA'`
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
    INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "entityId", "productId", "appliedAmount", "approvedAmount",
      "appliedTermDays", "ncaRegime", "ncaClassificationRule", "ncaClassifiedAt", "ncaClassifiedById", "updatedAt")
    VALUES (${lit(applicationId)}, ${lit(fx.tenantId)}, ${lit(applicationId)}, ${borrower.client}, ${borrower.entity}, ${lit(fx.product)},
      ${applied}, ${applied}, 1095, ${regime}, CURRENT_TIMESTAMP, ${lit(fx.officer)}, CURRENT_TIMESTAMP);
    COMMIT;`)
  const insert = `INSERT INTO "AssetFinanceDeal" ("id", "tenantId", "applicationId", "clientId", "entityId", "assetId", "supplierId",
      "depositCents", "tradeInCents", "financedFeesCents",
      "weights", "structurePreset", "firstDueDate", "rateBasis", "rateMargin", "baseInstalmentCents", "createdById", "dealerId", "dealerUserId", "updatedAt")
    VALUES (${lit(dealId)}, ${lit(fx.tenantId)}, ${lit(applicationId)}, ${borrower.client}, ${borrower.entity}, ${lit(input.assetId)},
      ${lit(fx.supplier)}, ${deposit}, ${tradeIn}, ${DEALER_DEAL_FEES_CENTS}, '[]', 'MONTHLY_36', ${TODAY_SQL} + 31, 'PRIME', 0.01, 5000000,
      ${lit(input.createdById ?? input.dealerUserId ?? fx.officer)}, ${lit(input.dealerId)}, ${lit(input.dealerUserId)}, CURRENT_TIMESTAMP)`
  return { dealId, applicationId, insert }
}

/** INSERT a deal (every trigger on). */
export function dealerDeal(fx: DealerFixture, input: DealerDealInput): { dealId: string; applicationId: string } {
  const { insert, ...ids } = dealerDealInsert(fx, input)
  sql(insert)
  return ids
}

/** DRAFT → SUBMITTED; a dealer deal is first handed over (AssetFinanceDeal_dealer_handover). */
export const submitSql = (dealId: string) =>
  `UPDATE "AssetFinanceDeal" SET "dealerSubmittedAt" = CURRENT_TIMESTAMP
     WHERE "id" = ${lit(dealId)} AND "dealerId" IS NOT NULL AND "dealerSubmittedAt" IS NULL;
   UPDATE "AssetFinanceDeal" SET "status" = 'SUBMITTED' WHERE "id" = ${lit(dealId)}`

export const approveSql = (fx: DealerFixture, dealId: string, extra = "") =>
  `UPDATE "AssetFinanceDeal" SET "status" = 'APPROVED', "decision" = 'APPROVE', "decidedById" = ${lit(fx.adminA)},
     "decidedAt" = CURRENT_TIMESTAMP${extra} WHERE "id" = ${lit(dealId)}`

/** SUBMITTED then APPROVED, every trigger on. */
export function approve(fx: DealerFixture, dealId: string): void {
  sql(`${submitSql(dealId)}; ${approveSql(fx, dealId)}`)
}

export interface BookOptions {
  /** SQL timestamp expression for Loan.maturityDate; default three years from now. */
  maturity?: string
}

/** Book an APPROVED deal (see the header). Returns the loan id. */
export function book(fx: DealerFixture, dealId: string, opts: BookOptions = {}): string {
  const loanId = newId("loan")
  const evidence = newId("doc")
  const deal = lit(dealId)
  sql(`BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE "AssetFinanceDeal" SET "status" = 'CONTRACTED', "plannedStartDate" = ${TODAY_SQL}, "signedBaseInstalmentCents" = "baseInstalmentCents",
      "signedResultingRate" = 0.1175, "signedTotalInterestCents" = 1000000, "signedCollectionFeeCents" = 0, "preparedSigners" = '[]'
      WHERE "id" = ${deal};
    UPDATE "LoanApplication" a SET "status" = 'DISBURSED', "repaymentMethod" = 'EFT', "approvedAt" = CURRENT_TIMESTAMP,
      "approvedById" = ${lit(fx.adminA)}, "disbursedAt" = CURRENT_TIMESTAMP
      FROM "AssetFinanceDeal" d WHERE d."id" = ${deal} AND a."id" = d."applicationId";
    INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "entityId", "productId", "assetId", "principal",
      "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate", "interestRatePm",
      "interestModel", "ncaRegime", "contractType", "nonNcaCollectionFeeCents", "updatedAt")
    SELECT ${lit(loanId)}, d."tenantId", ${lit(loanId)}, d."applicationId", d."clientId", d."entityId", a."productId", d."assetId",
      a."appliedAmount", 1000000, 0, a."appliedAmount" + 1000000, a."appliedAmount", now() AT TIME ZONE 'UTC',
      ${opts.maturity ?? `(now() AT TIME ZONE 'UTC') + INTERVAL '3 years'`}, 1.0, 'DAILY_ACCRUAL', a."ncaRegime", d."contractType", 0, CURRENT_TIMESTAMP
    FROM "AssetFinanceDeal" d JOIN "LoanApplication" a ON a."id" = d."applicationId" WHERE d."id" = ${deal};
    INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "resultingRate")
      VALUES (${lit(newId("cr"))}, ${lit(fx.tenantId)}, ${lit(loanId)}, ${TODAY_SQL}, 'PRIME', 0.01, 0.1175);
    INSERT INTO "EntityDocument" ("id", "tenantId", "entityId", "clientId", "dealId", "docType", "fileName", "mimeType", "fileSize",
      "storagePath", "contentSha256", "uploadedByType", "uploadedById")
    SELECT ${lit(evidence)}, d."tenantId", d."entityId", d."clientId", d."id", 'SUPPLIER_INVOICE', 'invoice.pdf', 'application/pdf', 1,
      '/nonexistent/invoice.pdf', repeat('0', 64), 'staff', ${lit(fx.officer)} FROM "AssetFinanceDeal" d WHERE d."id" = ${deal};
    INSERT INTO "PayoutChecklistItem" ("id", "tenantId", "dealId", "item", "confirmedById", "confirmedAt", "evidenceDocumentId", "attestedIdentifier")
    SELECT ${lit(newId("pci"))}, d."tenantId", d."id", 'SUPPLIER_INVOICE_MATCHES_ASSET', ${lit(fx.officer)}, CURRENT_TIMESTAMP, ${lit(evidence)},
      "assetIdentifierKey"(f."serialNumber")
    FROM "AssetFinanceDeal" d JOIN "FinancedAsset" f ON f."id" = d."assetId" WHERE d."id" = ${deal};
    INSERT INTO "Payout" ("id", "tenantId", "dealId", "supplierBankAccountId", "amountCents", "status", "createdById", "approvedById", "approvedAt")
      VALUES (${lit(newId("po"))}, ${lit(fx.tenantId)}, ${deal}, ${lit(fx.supplierAccount)}, 1, 'APPROVED', ${lit(fx.adminA)}, ${lit(fx.adminA)}, CURRENT_TIMESTAMP);
    COMMIT;`)
  sql(`UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED', "loanId" = ${lit(loanId)} WHERE "id" = ${deal}`)
  return loanId
}

/** Capture, insert, approve and book a deal of `dealerId` by `dealerUserId`. */
export function bookedDealerDeal(
  fx: DealerFixture, dealerId: string, dealerUserId: string, opts: BookOptions & { baseCents?: number } = {},
): { dealId: string; loanId: string } {
  const captured = captureForDealer(fx, dealerId)
  const { dealId } = dealerDeal(fx, { dealerId, dealerUserId, ...captured, baseCents: opts.baseCents })
  approve(fx, dealId)
  return { dealId, loanId: book(fx, dealId, opts) }
}

/** The deal's commission lines, oldest first, as psql rows (`|`-separated). */
export function commissionLines(dealId: string, columns = `"kind", "netCents", "vatCents", "grossCents", "reason"`): string[] {
  const out = sql(`SELECT ${columns} FROM "DealerCommissionLine" WHERE "dealId" = ${lit(dealId)} ORDER BY "createdAt", "kind"`)
  return out ? out.split("\n") : []
}
