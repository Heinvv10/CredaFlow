/**
 * Real-Postgres proof of the payout-side database rules (guardPayout and its
 * CANCELLED moves, Payout_status_shape, guardAssetDealCancel,
 * guardAssetDealBooking with the signed terms, guardPayoutChecklistItem with
 * the serial/VIN attestation, guardContractRate's first-row branch), one
 * probe per rule, each in a rolled-back transaction
 * (./review-gates.integration-fixture.ts). The fixture itself proves booking
 * is refused with the payout PENDING_APPROVAL and with its account no longer
 * APPROVED. Deal A is CONTRACTED with an APPROVED payout to a superseded
 * account; deal B BOOKED.
 *
 *   RUN_ASSET_FINANCE_REVIEW_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/review-gates-payout.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type PayoutChecklistItemKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { cleanupBookingFixture, type SessionUser } from "./payout-booking.integration-fixture"
import { acceptedSql, createReviewGatesFixture, refusedSql, reopenItem, type ReviewGatesFixture } from "./review-gates.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_REVIEW_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: ReviewGatesFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_REVIEW_IT=1 is required")
  return db
}
const A = () => fx.dealId
const B = () => fx.dealB
const deal = (id: string, set: string) => `UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${id}'`
const payout = (id: string, set: string) => `UPDATE "Payout" SET ${set} WHERE "dealId" = '${id}'`
const asset = (set: string) => `UPDATE "FinancedAsset" SET ${set} WHERE "id" = '${fx.assetA}'`
const evidence = (type: string) => `(SELECT "id" FROM "EntityDocument" WHERE "dealId" = '${A()}' AND "docType" = '${type}' LIMIT 1)`
const confirm = (item: PayoutChecklistItemKind, type: string, extra = "") => `UPDATE "PayoutChecklistItem"
  SET "confirmedById" = '${fx.officer}', "confirmedAt" = now(), "evidenceDocumentId" = ${evidence(type)}${extra}
  WHERE "dealId" = '${A()}' AND "item" = '${item}'`
const insertItem = (item: PayoutChecklistItemKind, required: boolean, confirmed: boolean) => `INSERT INTO "PayoutChecklistItem"
  ("id", "tenantId", "dealId", "item", "required", "confirmedById", "confirmedAt")
  VALUES ('item_${t}', '${fx.tenantId}', '${A()}', '${item}', ${required}, ${confirmed ? `'${fx.officer}', now()` : "NULL, NULL"})`

suite.sequential("review gates: payout, booking, checklist and contract rate (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createReviewGatesFixture(database(), t, (user) => { session.current = user && { user } })
  }, 240_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  describe("guardPayout and Payout_status_shape", () => {
    it("approval only while the deal is CONTRACTED", () => {
      const pending = `${payout(A(), `"status" = 'PENDING_APPROVAL', "approvedById" = NULL, "approvedAt" = NULL`)}`
      const approve = payout(A(), `"status" = 'APPROVED', "approvedById" = '${fx.adminB}', "approvedAt" = now()`)
      expect(refusedSql(`${pending}; ${deal(A(), `"status" = 'APPROVED'`)}`, approve)).toContain("A payout is approved only while its deal is CONTRACTED")
      acceptedSql(pending, approve)
    })

    it("release only with the deal BOOKED, and only to an account still APPROVED", () => {
      const release = payout(A(), `"status" = 'RELEASED', "releasedById" = '${fx.adminA}', "releasedAt" = now()`)
      expect(refusedSql("", release)).toContain("A payout is released only with its deal BOOKED")
      const booked = deal(A(), `"status" = 'BOOKED'`)
      expect(refusedSql(booked, release)).toContain("A payout is released only to a bank account that is still APPROVED")
      acceptedSql(`${booked}; ${payout(A(), `"supplierBankAccountId" = '${fx.newAccountId}'`)}`, release)
    })

    it("fixed fields, never deleted, the status shape", () => {
      expect(refusedSql("", payout(A(), `"amountCents" = "amountCents" + 1`))).toContain("A payout's deal, account, amount and creator are fixed")
      expect(refusedSql("", `DELETE FROM "Payout" WHERE "dealId" = '${A()}'`)).toContain("A payout is never deleted")
      expect(refusedSql("", payout(A(), `"status" = 'RELEASED'`), { triggers: false })).toContain("Payout_status_shape")
      expect(refusedSql("", payout(A(), `"status" = 'CANCELLED'`), { triggers: false })).toContain("Payout_status_shape")
      expect(refusedSql("", payout(A(), `"cancelledAt" = now(), "cancelledById" = '${fx.adminA}'`), { triggers: false })).toContain("Payout_status_shape")
    })

    it("CANCELLED only while the deal is CONTRACTED; a cancelled payout never changes", () => {
      const cancel = payout(A(), `"status" = 'CANCELLED', "cancelledById" = '${fx.adminA}', "cancelledAt" = now()`)
      expect(refusedSql(deal(A(), `"status" = 'APPROVED'`), cancel)).toContain("A payout is cancelled only while its deal is CONTRACTED")
      acceptedSql("", cancel)
      expect(refusedSql(cancel, payout(A(), `"status" = 'APPROVED'`))).toContain("A cancelled payout is immutable")
    })

    it("a deal is cancelled only once its payout is", () => {
      const cancelDeal = deal(A(), `"status" = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = '${fx.adminA}', "cancelReason" = 'Synthetic cancellation'`)
      expect(refusedSql("", cancelDeal)).toContain("A deal is cancelled only once its payout is cancelled")
      acceptedSql(payout(A(), `"status" = 'CANCELLED', "cancelledById" = '${fx.adminA}', "cancelledAt" = now()`), cancelDeal)
    })
  })

  describe("guardAssetDealBooking: the booked loan carries the signed terms", () => {
    const reset = () => `${deal(B(), `"status" = 'CONTRACTED', "loanId" = NULL`)};
      ${payout(B(), `"status" = 'APPROVED', "releasedById" = NULL, "releasedAt" = NULL`)}`
    const bookB = () => deal(B(), `"status" = 'BOOKED', "loanId" = '${fx.loanB}'`)
    const loan = (set: string) => `UPDATE "Loan" SET ${set} WHERE "id" = '${fx.loanB}'`

    it("the real booking passes the gate", () => {
      acceptedSql(reset(), bookB())
    })

    it.each([
      ["from CONTRACTED", () => deal(B(), `"status" = 'APPROVED'`), "An asset deal is booked only from CONTRACTED"],
      ["its own loan", () => loan(`"assetId" = '${fx.assetA}'`), "A booked deal names a classified loan on its own application, borrower and asset"],
      ["the payout APPROVED", () => payout(B(), `"status" = 'PENDING_APPROVAL', "approvedById" = NULL, "approvedAt" = NULL`), "A deal is booked only with its payout APPROVED"],
      ["the planned start", () => loan(`"startDate" = "startDate" + INTERVAL '1 day'`), "A booked loan starts on the deal's planned start date"],
      ["the signed margin", () => loan(`"nonNcaDefaultInterestMargin" = 0.03`), "carries the signed arrears terms"],
      ["the signed fee", () => loan(`"nonNcaCollectionFeeCents" = 1`), "carries the signed arrears terms"],
      ["the signed instalment", () => deal(B(), `"baseInstalmentCents" = "baseInstalmentCents" + 1`), "A booked deal's instalment is the signed instalment"],
      ["the signed rate", () => deal(B(), `"signedResultingRate" = 0.2`), "A booked loan's contract rate on its start date is the signed rate"],
      ["the attestation", () => `UPDATE "PayoutChecklistItem" SET "attestedIdentifier" = 'WRONG' WHERE "dealId" = '${B()}' AND "item" = 'SUPPLIER_INVOICE_MATCHES_ASSET'`,
        "the serial/VIN attested from the supplier invoice is the asset's"],
    ])("refuses without %s", (_label, setup, message) => {
      expect(refusedSql(`${reset()}; ${setup()}`, bookB())).toContain(message)
    })

    it("a deal names its loan only when booked", () => {
      expect(refusedSql("", deal(A(), `"loanId" = '${fx.loanB}'`))).toContain("A deal names its loan only when it is booked")
    })
  })

  describe("guardPayoutChecklistItem", () => {
    it("rows are created unconfirmed, with required as the requirement table says", () => {
      expect(refusedSql(`DELETE FROM "PayoutChecklistItem" WHERE "dealId" = '${A()}' AND "item" = 'TRACKER_CONFIRMED'`, insertItem("TRACKER_CONFIRMED", true, true)))
        .toContain("A payout checklist item is created unconfirmed")
      expect(refusedSql(`DELETE FROM "PayoutChecklistItem" WHERE "dealId" = '${A()}' AND "item" = 'NATIS_TITLEHOLDER'`, insertItem("NATIS_TITLEHOLDER", false, false)))
        .toContain("required must be what the requirement table says")
    })

    it("confirmed only while the deal is CONTRACTED", () => {
      const attempt = confirm("TRACKER_CONFIRMED", "TRACKER_CERTIFICATE")
      expect(refusedSql(`${reopenItem(A(), "TRACKER_CONFIRMED")}; ${deal(A(), `"status" = 'APPROVED'`)}`, attempt))
        .toContain("Payout checklist items are created and confirmed only while the deal is CONTRACTED")
      acceptedSql(reopenItem(A(), "TRACKER_CONFIRMED"), attempt)
    })

    it.each([
      ["INSURANCE_NOTES_LENDER", "INSURANCE_NOTING", () => asset(`"lenderNotedConfirmed" = false`), "does not record the lender's interest as noted"],
      ["TRACKER_CONFIRMED", "TRACKER_CERTIFICATE", () => asset(`"trackerId" = NULL`), "The asset has no tracker id"],
      ["SUPPLIER_BANK_VERIFIED", "BANK_STATEMENT", () => `UPDATE "SupplierBankAccount" SET "status" = 'SUPERSEDED' WHERE "id" = '${fx.newAccountId}'`,
        "The supplier has no APPROVED bank account"],
      ["NATIS_TITLEHOLDER", "NATIS_DOCUMENT", () => asset(`"natisTitleholder" = 'SOMEONE ELSE'`), "The eNaTIS titleholder must be the lender's legal name"],
    ] as const)("an asset fact: %s", (item, type, fact, message) => {
      expect(refusedSql(`${reopenItem(A(), item)}; ${fact()}`, confirm(item, type))).toContain(message)
    })

    it("the serial/VIN attested from the invoice must be the asset's, as the duplicate checks compare it", async () => {
      const serial = (await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assetA } })).serialNumber
      const open = reopenItem(A(), "SUPPLIER_INVOICE_MATCHES_ASSET")
      expect(refusedSql(open, confirm("SUPPLIER_INVOICE_MATCHES_ASSET", "SUPPLIER_INVOICE")))
        .toContain("The serial or VIN attested from the supplier invoice must be the asset's")
      expect(refusedSql(open, confirm("SUPPLIER_INVOICE_MATCHES_ASSET", "SUPPLIER_INVOICE", `, "attestedIdentifier" = 'WRONG'`)))
        .toContain("The serial or VIN attested from the supplier invoice must be the asset's")
      acceptedSql(open, confirm("SUPPLIER_INVOICE_MATCHES_ASSET", "SUPPLIER_INVOICE", `, "attestedIdentifier" = '${serial.toLowerCase().split("").join(" ")}'`))
    })
  })

  it("a supplier bank account's requester and decider are users of its tenant (composite FKs)", () => {
    const request = (requester: string) => `INSERT INTO "SupplierBankAccount" ("id", "tenantId", "supplierId", "bankName", "branchCode",
      "accountNumber", "accountHolder", "requestedById") VALUES ('acc_${t}', '${fx.tenantId}', '${fx.supplier}', 'TEST Bank', '000009',
      '0000000009', 'TEST Plant Sales (Pty) Ltd', '${requester}')`
    expect(refusedSql("", request("ghost-user"))).toContain("SupplierBankAccount_tenantId_requestedById_fkey")
    acceptedSql("", request(fx.officer))
    const decide = `UPDATE "SupplierBankAccount" SET "status" = 'REJECTED', "decidedById" = 'ghost-user', "decidedAt" = now() WHERE "id" = 'acc_${t}'`
    expect(refusedSql(request(fx.officer), decide)).toContain("SupplierBankAccount_tenantId_decidedById_fkey")
  })

  describe("guardContractRate: a booked loan's first rate is its deal's", () => {
    const clear = () => `DELETE FROM "ContractRate" WHERE "loanId" = '${fx.loanB}'`
    const insert = (margin: string, resulting: string, dayOffset: number) => `INSERT INTO "ContractRate"
      ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "resultingRate", "createdById")
      SELECT 'cr_${t}', d."tenantId", d."loanId", d."plannedStartDate" + ${dayOffset}, 'PRIME', ${margin}, ${resulting}, '${fx.adminA}'
      FROM "AssetFinanceDeal" d WHERE d."id" = '${B()}'`

    it("the deal's basis and margin, effective on the loan's start date", () => {
      acceptedSql(clear(), insert("0.01", "0.1175", 0))
      expect(refusedSql(clear(), insert("0.02", "0.1275", 0))).toContain("A loan's first contract rate is its deal's basis and margin")
      expect(refusedSql(clear(), insert("0.01", "0.1175", 1))).toContain("A loan's first contract rate is its deal's basis and margin")
    })
  })
})
