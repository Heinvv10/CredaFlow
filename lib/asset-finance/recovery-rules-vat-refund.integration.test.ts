/**
 * Slice 4a VAT event, surplus refund, asset-on-a-new-deal and catalog rules
 * (migration 20261015400000), each proved as in the lease suites: the attack
 * is refused, and goes through with that one statement, clause, CHECK or
 * index taken out, inside a rolled-back transaction. A VAT event is immutable,
 * one per kind, of the loan's own contract type, with input tax = value x rate
 * / (10000 + rate) half-up on a deemed supply and none on a lessor resale. A
 * refund is the whole surplus, approved and released by two people. A
 * recovered or remarketed asset cannot go on a new deal. Every table has
 * row-level security and refuses TRUNCATE. The VAT treatment is UNTESTED
 * against the tax law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-vat-refund.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type ContractType } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, day, legalDocument, newAsset, newLoan, newRecovery, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { attempt } from "./lease-servicing.integration-fixture"
import { PASS_DELETE, raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
/** vatDone: an instalment sale that already has its (committed) deemed-supply event. */
const R = {} as Record<"sale" | "vatDone" | "finance" | "operating" | "gone" | "surplus" | "listed", Rec>
let bankDocument = ""

// R115 000 incl. VAT at 15%: input tax R15 000.
const vat = (tx: Pick<PrismaClient, "recoveryVatEvent">, rec: Rec, over: Record<string, unknown> = {}) => tx.recoveryVatEvent.create({
  data: {
    tenantId: fx.tenantId, recoveryId: rec.id, kind: "REPOSSESSION_DEEMED_SUPPLY", eventDate: dbDate(today()), dealContractType: "INSTALMENT_SALE" as ContractType, debtorVatVendor: false,
    deemedSupplyValueCents: 11_500_000, inputTaxClaimCents: 1_500_000, outputTaxCents: 0, vatRateTenThousandths: 1500, basis: "Synthetic s8(10) basis", recordedById: fx.officer, ...over,
  } as never,
})
const resale = (tx: Tx, over: Record<string, unknown> = {}) =>
  vat(tx, R.operating, { kind: "LESSOR_RESALE", dealContractType: "OPERATING_LEASE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0, outputTaxCents: 1_500_000, ...over })

const refund = (tx: Pick<PrismaClient, "recoveryRefund">, over: Record<string, unknown> = {}) => tx.recoveryRefund.create({
  data: {
    tenantId: fx.tenantId, recoveryId: R.surplus.id, amountCents: 40_000_000, accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000001",
    bankVerifiedById: fx.adminA, bankVerificationDocumentId: bankDocument, createdById: fx.officer, ...over,
  } as never,
})
const G = "guardRecoveryRefund"
const close = (tx: Tx) => tx.recovery.update({ where: { id: R.surplus.id }, data: { status: "CLOSED", closedAt: new Date() } })

suite("slice 4a VAT event, refund, deal and catalog database rules", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    for (const [name, contractType] of [["sale", "INSTALMENT_SALE"], ["vatDone", "INSTALMENT_SALE"], ["finance", "FINANCE_LEASE"], ["operating", "OPERATING_LEASE"], ["gone", "INSTALMENT_SALE"]] as const) {
      const loan = await newLoan(database(), fx, "NON_NCA", contractType)
      R[name] = { loan, id: await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY") }
    }
    await database().recovery.update({ where: { id: R.gone.id }, data: { status: "WITHDRAWN", withdrawnReason: "Debtor paid the arrears in full", closedAt: new Date() } })
    R.surplus = await ladderRecovery(database(), fx, true, "SURPLUS_HELD", { settlementCents: 80_000_000 })
    R.listed = await ladderRecovery(database(), fx, false, "LISTED")
    bankDocument = await legalDocument(database(), fx, "OTHER")
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("VAT event", () => {
    it("is immutable, and one per kind per recovery", async () => {
      const id = (await vat(database(), R.vatDone)).id
      await refuses(raiseOff("guardRecoveryVatEvent", "A recovery VAT event is immutable"), /VAT event is immutable/, (tx) => tx.recoveryVatEvent.update({ where: { id }, data: { basis: "edited basis" } }))
      await refuses(raiseOff("guardRecoveryVatEvent", "A recovery VAT event is immutable", PASS_DELETE), /VAT event is immutable/, (tx) => tx.recoveryVatEvent.delete({ where: { id } }))
      await refuses({ index: "RecoveryVatEvent_tenantId_recoveryId_kind_key" }, /Unique constraint|RecoveryVatEvent_tenantId_recoveryId_kind_key/, (tx) => vat(tx, R.vatDone))
      await admits((tx) => vat(tx, R.finance, { dealContractType: "FINANCE_LEASE" }))
    })

    it("belongs to a live recovery and records its loan's contract type", async () => {
      const rule = raiseOff("guardRecoveryVatEvent", "A VAT event belongs to a live recovery and records its loan's contract type")
      await refuses(rule, /live recovery and records its loan's contract type/, (tx) => vat(tx, R.gone))
      await refuses(rule, /live recovery and records its loan's contract type/, (tx) => vat(tx, R.sale, { dealContractType: "FINANCE_LEASE" }))
    })

    it("is a deemed supply on an instalment sale or finance lease, a lessor resale on an operating or maintenance lease", async () => {
      const rule = raiseOff("guardRecoveryVatEvent", "A deemed supply belongs to an instalment sale or finance lease, a lessor resale to an operating or maintenance lease")
      const message = /deemed supply belongs to an instalment sale or finance lease/
      await refuses(rule, message, (tx) => vat(tx, R.operating, { dealContractType: "OPERATING_LEASE" }))
      await refuses(rule, message, (tx) => vat(tx, R.sale, { kind: "LESSOR_RESALE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0, outputTaxCents: 1_500_000 }))
      await admits((tx) => resale(tx))
    })

    it("is not dated in the future", async () => {
      await refuses(raiseOff("guardRecoveryVatEvent", "A VAT event is not dated in the future"), /VAT event is not dated in the future/, (tx) => vat(tx, R.sale, { eventDate: dbDate(day(1)) }))
    })

    it("claims input tax = value x rate / (10000 + rate), half-up, on a deemed supply", async () => {
      const check = { table: "RecoveryVatEvent", constraint: "RecoveryVatEvent_input_tax_formula" }
      await refuses(check, /RecoveryVatEvent_input_tax_formula/, (tx) => vat(tx, R.sale, { inputTaxClaimCents: 1_499_999 }))
      await refuses(check, /RecoveryVatEvent_input_tax_formula/, (tx) => vat(tx, R.sale, { deemedSupplyValueCents: 105, inputTaxClaimCents: 13 })) // 13.69 rounds up to 14
      await admits((tx) => vat(tx, R.sale, { deemedSupplyValueCents: 105, inputTaxClaimCents: 14 }))
      await admits((tx) => vat(tx, R.sale, { debtorVatVendor: true, debtorVatNumber: "4000000099" }))
    })

    it("claims nothing and deems nothing on a lessor resale", async () => {
      const check = { table: "RecoveryVatEvent", constraint: "RecoveryVatEvent_resale_no_deemed_supply" }
      await refuses(check, /RecoveryVatEvent_resale_no_deemed_supply/, (tx) => resale(tx, { deemedSupplyValueCents: 11_500_000 }))
      await refuses(check, /RecoveryVatEvent_resale_no_deemed_supply/, (tx) => resale(tx, { inputTaxClaimCents: 1 }))
    })

    it("keeps amounts non-negative, the rate in range, a basis and a recorder; a VAT number only for a vendor", async () => {
      const amounts = { table: "RecoveryVatEvent", constraint: "RecoveryVatEvent_amounts" }
      await refuses(amounts, /RecoveryVatEvent_amounts/, (tx) => vat(tx, R.sale, { outputTaxCents: -1 }))
      await refuses(amounts, /RecoveryVatEvent_amounts/, (tx) => vat(tx, R.sale, { vatRateTenThousandths: 0, inputTaxClaimCents: 0 }))
      await refuses(amounts, /RecoveryVatEvent_amounts/, (tx) => vat(tx, R.sale, { basis: " " }))
      await refuses({ table: "RecoveryVatEvent", constraint: "RecoveryVatEvent_vendor_number" }, /RecoveryVatEvent_vendor_number/, (tx) => vat(tx, R.sale, { debtorVatVendor: false, debtorVatNumber: "4000000099" }))
    })
  })

  describe("surplus refund", () => {
    it("is the whole surplus of a recovery that holds one", async () => {
      const rule = raiseOff(G, "A refund is the whole surplus of a recovery that holds one")
      await refuses(rule, /whole surplus of a recovery that holds one/, (tx) => refund(tx, { amountCents: 39_999_999 }))
      await refuses(rule, /whole surplus of a recovery that holds one/, (tx) => refund(tx, { recoveryId: R.listed.id }))
      await admits((tx) => refund(tx))
    })

    it("opens PENDING_APPROVAL", async () => {
      await refuses(raiseOff(G, "A refund opens PENDING_APPROVAL"), /refund opens PENDING_APPROVAL/, (tx) => refund(tx, { status: "APPROVED", approvedById: fx.adminB }))
    })

    it("fixes its amount, account and bank verification", async () => {
      const rule = raiseOff(G, "A refund's amount, account and bank verification are fixed")
      const message = /amount, account and bank verification are fixed/
      await refuses(rule, message, async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED", approvedById: fx.adminB, accountNumber: "0000000002" } }))
      await refuses(rule, message, async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED", approvedById: fx.adminB, bankVerifiedById: fx.adminB } }))
    })

    it("is approved, then released, once each: no skipping, no going back, never deleted", async () => {
      const rule = raiseOff(G, "A refund is approved, then released, once each")
      const message = /approved, then released, once each/
      const approved = async (tx: Tx) => { const r = await refund(tx); await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } }); return r.id }
      await refuses(rule, message, async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "RELEASED", approvedById: fx.adminB, releasedById: fx.adminB, releasedAt: new Date() } }))
      await refuses(rule, message, async (tx) => tx.recoveryRefund.update({ where: { id: await approved(tx) }, data: { status: "PENDING_APPROVAL", approvedById: null } }))
      await refuses(raiseOff(G, "A recovery refund is never deleted", PASS_DELETE), /refund is never deleted/, async (tx) => tx.recoveryRefund.delete({ where: { id: await approved(tx) } }))
    })

    it("is approved by someone other than its creator, and releases only once approved (CHECKs)", async () => {
      const approveBy = (approver: string) => async (tx: Tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED", approvedById: approver } })
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_approver_differs" }, /RecoveryRefund_approver_differs/, approveBy(fx.officer))
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_status_columns" }, /RecoveryRefund_status_columns/,
        async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED" } }))
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_shape" }, /RecoveryRefund_shape/, (tx) => refund(tx, { accountHolder: " " }))
      await admits(approveBy(fx.adminB))
    })

    it("is one per recovery", async () => {
      const second = async (tx: Tx) => { await refund(tx); await refund(tx) }
      await refuses({ index: "RecoveryRefund_recoveryId_key" }, /Unique constraint|RecoveryRefund_recoveryId_key/, second, [{ index: "RecoveryRefund_tenantId_recoveryId_key" }])
    })

    it("closes the recovery only once the refund is released, and then closes it", async () => {
      const released = async (tx: Tx) => {
        const r = await refund(tx)
        await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } })
        return r.id
      }
      await refuses(raiseOff("guardRecovery", "A surplus closes when its refund is released"), /surplus closes when its refund is released/, async (tx) => { await released(tx); await close(tx) })
      await admits(async (tx) => {
        const id = await released(tx)
        await tx.recoveryRefund.update({ where: { id }, data: { status: "RELEASED", releasedById: fx.adminA, releasedAt: new Date() } })
        await close(tx)
      })
    })
  })

  describe("a recovered asset on a new deal", () => {
    const deal = async (tx: Tx, rec: Rec) => {
      const loan = await tx.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId }, select: { applicationId: true, entityId: true, clientId: true } })
      // Only the asset rule is under test: every other deal trigger is off for the insert, then back on.
      await tx.$executeRawUnsafe(`ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER USER`)
      await tx.$executeRawUnsafe(`ALTER TABLE "AssetFinanceDeal" ENABLE TRIGGER "AssetFinanceDeal_asset_unreleased"`)
      await tx.$executeRawUnsafe(
        `INSERT INTO "AssetFinanceDeal" ("id", "tenantId", "applicationId", "clientId", "entityId", "assetId", "supplierId", "weights", "structurePreset", "firstDueDate", "rateBasis", "createdById", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, '[1]'::jsonb, 'MONTHLY', CURRENT_DATE, 'PRIME', $8, CURRENT_TIMESTAMP)`,
        `deal_rcv_${randomUUID().replaceAll("-", "").slice(0, 12)}`, fx.tenantId, loan.applicationId, loan.clientId, loan.entityId, rec.loan.assetId, fx.supplier, fx.officer,
      )
    }
    const newDeal = (assetId: string) => async (tx: Tx) => deal(tx, { id: "", loan: { ...R.sale.loan, assetId } })

    it("is refused for a RECOVERED or SOLD_IN_REMARKETING asset, and admitted for a free one", async () => {
      const rule = raiseOff("guardAssetDealUnreleasedAsset", "A recovered asset cannot be financed again")
      await refuses(rule, /recovered asset cannot be financed again/, newDeal(R.sale.loan.assetId))
      await refuses(rule, /recovered asset cannot be financed again/, async (tx) => {
        await triggersOff(tx)
        await tx.financedAsset.update({ where: { id: R.finance.loan.assetId }, data: { lessorStatus: "SOLD_IN_REMARKETING" } })
        await triggersOn(tx)
        await newDeal(R.finance.loan.assetId)(tx)
      })
      await admits(newDeal(await newAsset(database(), fx)))
    })
  })

  describe("the catalog", () => {
    const TABLES = ["LegalMatter", "LegalMatterStep", "Recovery", "RecoveryCost", "RemarketingSale", "RecoveryVatEvent", "RecoveryRefund"]

    it("has row-level security enabled and forced, with the tenant policy, on every new table", async () => {
      const rows = await database().$queryRaw<{ t: string; on: boolean; forced: boolean; policies: string[] }[]>`
        SELECT c.relname AS t, c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
               ARRAY(SELECT p.polname FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES})`
      expect(rows.map((r) => r.t).sort()).toEqual([...TABLES].sort())
      expect(rows.filter((r) => !r.on || !r.forced || r.policies.join() !== "tenant_isolation")).toEqual([])
    })

    it("refuses TRUNCATE of every guarded table by its own trigger", async () => {
      const messages: Record<string, RegExp> = {
        LegalMatter: /legal matter is never deleted/, LegalMatterStep: /append-only/, Recovery: /recovery is never deleted/, RecoveryCost: /cost is immutable/,
        RemarketingSale: /never deleted: cancel it/, RecoveryVatEvent: /VAT event is immutable/, RecoveryRefund: /refund is never deleted/,
      }
      for (const table of TABLES) {
        const truncate = (tx: Tx) => tx.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`)
        expect(await attempt(database(), truncate), table).toMatch(messages[table])
        // the table's own trigger is the one that refused: without it, the refusal (if any) is another table's
        expect(await attempt(database(), truncate, { table, trigger: `${table}_no_truncate` }), table).not.toMatch(messages[table])
      }
    })
  })
})
