/**
 * Slice 4a remarketing sale rules (migration 20261015400000), each proved as in the lease
 * suites: the attack is refused, and goes through with that one statement, clause, CHECK or
 * index taken out, inside a rolled-back transaction. A sale is recorded on a LISTED recovery against a current
 * independent (not internal) valuation of the asset; the trigger recomputes
 * belowValuation against the highest such valuation; a buyer carrying the
 * borrower's or a related client's ID is forced to relatedPartyMatch (its own
 * suite); a sale below valuation or to a related party completes only with a second approver;
 * one COMPLETED sale per recovery; a completed or cancelled sale is immutable;
 * completing it marks the asset SOLD_IN_REMARKETING. The sale policy is UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-sale.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { advance, saleData } from "./recovery-path.integration-fixture"
import {
  recordFixtureCommercialCancellation, cleanupRecoveryFixture, courtMatter, createRecoveryFixture, day, newLoan, newRecovery, recoveryFixtureTenantId, saleInvoice, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { clauseOff, PASS_DELETE, raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

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
const G = "guardRemarketingSale"
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
/** non: a NON_NCA recovery LISTED, with a PENDING sale; nca: an NCA (consumer) one LISTED; done: LISTED with a COMPLETED sale and a CANCELLED one; unlisted: VALUED. */
const R = {} as Record<"non" | "nca" | "done" | "unlisted", Rec>
let pendingSale = ""
let completedSale = ""
let cancelledSale = ""
let invoice = ""
let invoice90 = ""

const saleIn = async (tx: Tx, rec: Rec, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.create({ data: { ...(await saleData(database(), fx, rec.loan, rec.id)), ...over } as never })
const complete = (tx: Tx, id: string, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: invoice, ...over } })
/** Approval is its own step, before the one that completes the sale. */
const approve = (tx: Tx, id: string, by: string) => tx.remarketingSale.update({ where: { id }, data: { approvedById: by, approvedAt: new Date() } })
const listed = async (regime: "NCA" | "NON_NCA"): Promise<Rec> => {
  const loan = await newLoan(database(), fx, regime)
  const id = await newRecovery(database(), fx, loan, regime === "NCA" ? "NCA_S131_ATTACHMENT" : "NON_NCA_VOLUNTARY", regime === "NCA" ? { legalMatterId: await courtMatter(database(), fx, loan) } : {})
  await advance(database(), fx, loan, id, "LISTED")
  await recordFixtureCommercialCancellation(database(), fx, loan.loanId)
  return { loan, id }
}
suite("slice 4a remarketing sale database rules", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    invoice = await saleInvoice(database(), fx)
    invoice90 = await saleInvoice(database(), fx, 90_000_000)
    R.non = await listed("NON_NCA")
    R.nca = await listed("NCA")
    R.done = await listed("NON_NCA")
    const unlistedLoan = await newLoan(database(), fx, "NON_NCA")
    R.unlisted = { loan: unlistedLoan, id: await newRecovery(database(), fx, unlistedLoan, "NON_NCA_VOLUNTARY") }
    await advance(database(), fx, unlistedLoan, R.unlisted.id, "VALUED")
    await recordFixtureCommercialCancellation(database(), fx, unlistedLoan.loanId)
    pendingSale = (await database().remarketingSale.create({ data: (await saleData(database(), fx, R.non.loan, R.non.id)) as never })).id
    completedSale = (await database().remarketingSale.create({ data: (await saleData(database(), fx, R.done.loan, R.done.id)) as never })).id
    await database().remarketingSale.update({ where: { id: completedSale }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: await saleInvoice(database(), fx) } })
    cancelledSale = (await database().remarketingSale.create({ data: (await saleData(database(), fx, R.done.loan, R.done.id)) as never })).id
    await database().remarketingSale.update({ where: { id: cancelledSale }, data: { status: "CANCELLED" } })
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("marks the asset SOLD_IN_REMARKETING when the sale completes, and not before", async () => {
    const status = (id: string) => database().financedAsset.findUniqueOrThrow({ where: { id }, select: { lessorStatus: true } }).then((a) => a.lessorStatus)
    expect(await status(R.done.loan.assetId)).toBe("SOLD_IN_REMARKETING")
    expect(await status(R.non.loan.assetId)).toBe("RECOVERED")
  })

  describe("opening a sale", () => {
    it("opens PENDING_APPROVAL, unapproved, uninvoiced and unpaid", async () => {
      const rule = raiseOff(G, "A sale opens PENDING_APPROVAL, unapproved and uninvoiced")
      await refuses(rule, /opens PENDING_APPROVAL/, (tx) => saleIn(tx, R.non, { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: invoice }))
      await refuses(rule, /opens PENDING_APPROVAL/, (tx) => saleIn(tx, R.non, { approvedById: fx.adminB, approvedAt: new Date() }))
      await admits((tx) => saleIn(tx, R.non))
    })

    it("is recorded on a LISTED recovery, and completes only while it is still listed", async () => {
      const rule = raiseOff(G, "A sale is recorded and completed on a listed recovery")
      await refuses(rule, /on a listed recovery/, (tx) => saleIn(tx, R.unlisted))
      await refuses(rule, /on a listed recovery/, async (tx) => {
        const sale = await saleIn(tx, R.non)
        await triggersOff(tx) // the recovery moved on (here: back) after the sale was recorded
        await tx.recovery.update({ where: { id: R.non.id }, data: { status: "VALUED" } })
        await triggersOn(tx)
        await complete(tx, sale.id)
      })
    })
  })

  describe("the valuation relied on", () => {
    const stale = async (tx: Tx) => (await tx.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: R.non.loan.assetId, valuedOn: dbDate(day(-40)), source: "ASSESSOR", valuerName: "TEST", amountCents: 100_000_000 } })).id
    const internal = async (tx: Tx) => (await tx.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: R.non.loan.assetId, valuedOn: dbDate(today()), source: "INTERNAL", valuerName: "TEST", amountCents: 100_000_000 } })).id
    const foreign = async (tx: Tx) => (await tx.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: R.nca.loan.assetId, valuedOn: dbDate(today()), source: "ASSESSOR", valuerName: "TEST", amountCents: 100_000_000 } })).id
    const message = /relies on an independent \(not internal\) valuation of this asset dated within 30 days/

    it("is independent: an internal valuation will not do", async () => {
      await refuses(clauseOff(G, `AND v."source" <> 'INTERNAL' AND v."valuedOn" >= today - max_age) THEN`, `AND v."valuedOn" >= today - max_age) THEN`), message,
        async (tx) => saleIn(tx, R.non, { valuationId: await internal(tx) }))
    })

    it("is of this asset", async () => {
      await refuses(clauseOff(G, `WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId"`, `WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId"`), message,
        async (tx) => saleIn(tx, R.non, { valuationId: await foreign(tx) }))
    })

    it("is current: within the lender's valuation age (leasePurchaseValuationMaxAgeDays)", async () => {
      await refuses(clauseOff(G, `AND v."valuedOn" >= today - max_age) THEN`, `) THEN`), message, async (tx) => saleIn(tx, R.non, { valuationId: await stale(tx) }))
      await admits(async (tx) => {
        await tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { leasePurchaseValuationMaxAgeDays: 60 } })
        await saleIn(tx, R.non, { valuationId: await stale(tx) })
      })
    })
  })

  describe("below valuation", () => {
    it("is recomputed: the price under the highest current independent valuation, not the one relied on and not an internal one", async () => {
      const rule = clauseOff(G, `IF NEW."belowValuation" IS DISTINCT FROM (NEW."priceInclVatCents" < highest) THEN`, "IF false THEN")
      const message = /belowValuation is whether the price is under the highest current independent valuation/
      await refuses(rule, message, (tx) => saleIn(tx, R.non, { priceInclVatCents: 90_000_000, belowValuation: false }))
      await refuses(rule, message, (tx) => saleIn(tx, R.non, { belowValuation: true, belowValuationReason: "Claimed below, but it is not" }))
      await refuses(rule, message, async (tx) => {
        const higher = await newHigher(tx, 110_000_000, "ASSESSOR")
        await saleIn(tx, R.non, { priceInclVatCents: 105_000_000, belowValuation: false, highestValuationCents: higher })
      })
      await admits(async (tx) => {
        const higher = await newHigher(tx, 110_000_000, "INTERNAL") // an internal valuation never raises the bar
        await saleIn(tx, R.non, { priceInclVatCents: 105_000_000, belowValuation: false, highestValuationCents: higher - 10_000_000 })
      })
      await admits((tx) => saleIn(tx, R.non, { priceInclVatCents: 90_000_000, belowValuation: true, belowValuationReason: "Auction reserve not met on the day" }))
    })

    it("snapshots the highest current independent valuation", async () => {
      await refuses(raiseOff(G, "The highest valuation recorded is the highest current independent valuation"), /highest valuation recorded is the highest current independent valuation/,
        (tx) => saleIn(tx, R.non, { highestValuationCents: 1 }))
    })

    it("records a reason of at least 10 characters (CHECK RemarketingSale_below_reason)", async () => {
      await refuses({ table: "RemarketingSale", constraint: "RemarketingSale_below_reason" }, /RemarketingSale_below_reason/,
        (tx) => saleIn(tx, R.non, { priceInclVatCents: 90_000_000, belowValuation: true, belowValuationReason: "cheap" }))
    })

    it("must still be below on completion: a higher valuation recorded since forces a new sale", async () => {
      await refuses(clauseOff(G, `IF NEW."belowValuation" IS DISTINCT FROM (NEW."priceInclVatCents" < highest) THEN`, "IF false THEN"), /belowValuation is whether the price is under/, async (tx) => {
        const sale = await saleIn(tx, R.non)
        await newHigher(tx, 130_000_000, "DEALER")
        await complete(tx, sale.id)
      })
    })
  })

  describe("a second approver", () => {
    const check = { table: "RemarketingSale", constraint: "RemarketingSale_second_approver" }
    const message = /RemarketingSale_second_approver/
    const related = (tx: Tx) => saleIn(tx, R.nca, { buyerIdentifier: R.nca.loan.borrowerKey })
    const below = (tx: Tx) => saleIn(tx, R.non, { priceInclVatCents: 90_000_000, belowValuation: true, belowValuationReason: "Auction reserve not met on the day" })
    const completeBelow = (tx: Tx, id: string) => complete(tx, id, { taxInvoiceId: invoice90 })

    it("is needed to complete a sale to a related party, or one below valuation", async () => {
      await refuses(check, message, async (tx) => complete(tx, (await related(tx)).id))
      await refuses(check, message, async (tx) => completeBelow(tx, (await below(tx)).id))
    })

    it("is someone other than the sale's creator", async () => {
      await refuses(check, message, async (tx) => { const id = (await related(tx)).id; await approve(tx, id, fx.officer); await complete(tx, id) })
      await refuses(check, message, async (tx) => { const id = (await below(tx)).id; await approve(tx, id, fx.officer); await completeBelow(tx, id) })
    })

    it("lets a different approver complete it, and a plain sale need none", async () => {
      await admits(async (tx) => { const id = (await related(tx)).id; await approve(tx, id, fx.adminB); await complete(tx, id) })
      await admits(async (tx) => { const id = (await below(tx)).id; await approve(tx, id, fx.adminB); await completeBelow(tx, id) })
      await admits(async (tx) => complete(tx, (await saleIn(tx, R.non)).id))
      await admits((tx) => approve(tx, pendingSale, fx.adminB))
    })

    it("is given in a step of its own, written once, and not in the step that completes the sale", async () => {
      await refuses(raiseOff(G, "A sale's approval is written once"), /approval is written once/, async (tx) => {
        const id = (await saleIn(tx, R.non)).id
        await approve(tx, id, fx.adminB)
        await approve(tx, id, fx.adminA)
      })
      await refuses(raiseOff(G, "A sale is approved before the step that completes it"), /approved before the step that completes it/, async (tx) => {
        const id = (await saleIn(tx, R.non)).id
        await complete(tx, id, { approvedById: fx.adminB, approvedAt: new Date() })
      })
    })
  })

  describe("completion", () => {
    it("records when it completed and the tax invoice (CHECK RemarketingSale_completed_columns)", async () => {
      const check = { table: "RemarketingSale", constraint: "RemarketingSale_completed_columns" }
      // Isolate the null-invoice CHECK from the independent cancellation/date
      // guard, which also needs an invoice to verify the actual sale date.
      await refuses(check, /RemarketingSale_completed_columns/, async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "RemarketingSale" DISABLE TRIGGER "RemarketingSale_commercial_cancellation_guard"')
        return tx.remarketingSale.update({ where: { id: pendingSale }, data: { status: "COMPLETED", completedAt: new Date() } })
      },
        [raiseOff(G, "A sale's tax invoice is for its price, issued to the buyer outside the loan")])
      await refuses(check, /RemarketingSale_completed_columns/, (tx) => tx.remarketingSale.update({ where: { id: pendingSale }, data: { completedAt: new Date() } }))
    })

    it("carries a tax invoice for its price, issued to the buyer outside the loan", async () => {
      const rule = raiseOff(G, "A sale's tax invoice is for its price, issued to the buyer outside the loan")
      const message = /tax invoice is for its price, issued to the buyer outside the loan/
      const wrongTotal = await saleInvoice(database(), fx, 100_000_000)
      const loanBound = await saleInvoice(database(), fx, 120_000_000, R.non.loan.loanId)
      await refuses(rule, message, async (tx) => complete(tx, (await saleIn(tx, R.non)).id, { taxInvoiceId: wrongTotal }))
      await refuses(rule, message, async (tx) => complete(tx, (await saleIn(tx, R.non)).id, { taxInvoiceId: loanBound }))
    })

    it("completes only if the buyer has not become a related party since the sale was recorded", async () => {
      await refuses(raiseOff(G, "A buyer who is now a related party needs the sale re-recorded"), /now a related party needs the sale re-recorded/, async (tx) => {
        const id = (await saleIn(tx, R.non, { buyerIdentifier: "6001015800086" })).id
        const stranger = await tx.client.create({
          data: { tenantId: fx.tenantId, firstName: "TEST", lastName: "Newdirector", email: `new-${randomUUID().slice(0, 8)}@client.invalid`, phone: `0009${randomUUID().slice(0, 6)}`, idNumber: "6001015800086", popiaConsentGiven: true },
        })
        await tx.entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: R.non.loan.entityId!, clientId: stranger.id, role: "DIRECTOR" } })
        await complete(tx, id)
      })
    })

    it("is one COMPLETED sale per recovery", async () => {
      await refuses({ index: "RemarketingSale_one_completed_per_recovery" }, /Unique constraint|RemarketingSale_one_completed_per_recovery/, async (tx) => {
        await complete(tx, (await saleIn(tx, R.done)).id, { taxInvoiceId: await invoiceFor(tx) })
      }, [raiseOff("syncSaleAssetStatus", "A sale completes on a recovered asset")])
    })

    it("is an asset sale only while the asset is recovered", async () => {
      await refuses(raiseOff("syncSaleAssetStatus", "A sale completes on a recovered asset"), /completes on a recovered asset/, async (tx) => {
        await triggersOff(tx)
        await tx.financedAsset.update({ where: { id: R.non.loan.assetId }, data: { lessorStatus: null } })
        await triggersOn(tx)
        await complete(tx, pendingSale)
      })
    })
  })

  describe("a settled sale is final", () => {
    it("never changes once COMPLETED or CANCELLED, except the proceeds payment, set once", async () => {
      const rule = raiseOff(G, "A completed or cancelled sale is immutable (its proceeds payment is set once)")
      const message = /completed or cancelled sale is immutable/
      await refuses(rule, message, (tx) => tx.remarketingSale.update({ where: { id: completedSale }, data: { buyerName: "TEST Other Buyer" } }))
      await refuses(rule, message, (tx) => tx.remarketingSale.update({ where: { id: cancelledSale }, data: { status: "PENDING_APPROVAL" } }))
      await refuses(rule, message, (tx) => tx.remarketingSale.update({ where: { id: completedSale }, data: { status: "CANCELLED", completedAt: null } }))
      await admits(async (tx) => {
        const payment = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: R.done.loan.loanId, amount: 1000 } })
        await tx.remarketingSale.update({ where: { id: completedSale }, data: { proceedsPaymentId: payment.id } })
      })
    })

    it("fixes a pending sale's content: only its approval, completion and invoice move", async () => {
      await refuses(raiseOff(G, "A pending sale changes only its approval, completion and invoice"), /pending sale changes only its approval, completion and invoice/,
        (tx) => tx.remarketingSale.update({ where: { id: pendingSale }, data: { priceInclVatCents: 99_999_999 } }))
      await admits((tx) => tx.remarketingSale.update({ where: { id: pendingSale }, data: { status: "CANCELLED" } }))
    })

    it("is never deleted: a sale is cancelled", async () => {
      await refuses(raiseOff(G, "A remarketing sale is never deleted: cancel it", PASS_DELETE), /never deleted: cancel it/, (tx) => tx.remarketingSale.delete({ where: { id: cancelledSale } }))
    })
  })

  describe("the row's CHECK constraints", () => {
    it("names the buyer, prices the sale and keeps the screening result an object", async () => {
      await refuses({ table: "RemarketingSale", constraint: "RemarketingSale_buyer" }, /RemarketingSale_buyer/, (tx) => saleIn(tx, R.non, { buyerName: " " }))
      await refuses({ table: "RemarketingSale", constraint: "RemarketingSale_amounts" }, /RemarketingSale_amounts/, (tx) => saleIn(tx, R.non, { priceInclVatCents: 0, belowValuation: true, belowValuationReason: "Free of charge, per the seller" }))
      await refuses({ table: "RemarketingSale", constraint: "RemarketingSale_screening_shape" }, /RemarketingSale_screening_shape/, (tx) => saleIn(tx, R.non, { screeningResult: [] }))
      await refuses({ table: "RemarketingSale", constraint: "RemarketingSale_approval_pair" }, /RemarketingSale_approval_pair/, (tx) => tx.remarketingSale.update({ where: { id: pendingSale }, data: { approvedById: fx.adminB } }))
    })
  })
})

async function newHigher(tx: Tx, amountCents: number, source: "ASSESSOR" | "DEALER" | "INTERNAL"): Promise<number> {
  await tx.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: R.non.loan.assetId, valuedOn: dbDate(today()), source, valuerName: "TEST", amountCents } })
  return amountCents
}

/** A second tax invoice (one per sale), through test setup. */
async function invoiceFor(tx: Tx, totalCents = 120_000_000): Promise<string> {
  const id = `inv_rcv_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  await triggersOff(tx)
  await tx.$executeRawUnsafe(`INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate", "supplierName", "supplierAddress", "supplierVatNumber",
    "recipientName", "recipientAddress", "vatRate", "totalExclVatCents", "vatCents", "totalInclVatCents")
    VALUES ('${id}', '${fx.tenantId}', ${Math.floor(Math.random() * 1_000_000_000) + 1}, 'INV-X', CURRENT_DATE, CURRENT_DATE, 'TEST', 'A', '4000000001', 'B', 'C', 0.15, ${totalCents - Math.floor((totalCents * 15) / 115)}, ${Math.floor((totalCents * 15) / 115)}, ${totalCents})`)
  await triggersOn(tx)
  return id
}
