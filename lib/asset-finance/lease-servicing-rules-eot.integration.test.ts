/**
 * Each clause of the slice 3 C7 end-of-term rules refuses its attack, and is
 * what refuses it: the same attack goes through with that one clause taken
 * out of its trigger function (or the trigger off), inside a rolled-back
 * transaction. The inspection's timing per origin (expiry in arrears and in
 * advance, extension, early termination), never in the future or before the
 * election; the final reading (the asset's, dated the inspection, the
 * latest); extension notice bounds and the frozen end date; the frozen
 * billing figures; the purchase's valuation (source, four-eyes, age), its
 * sale invoice at the term end on a current valuation; completion once paid;
 * SOLD_TO_LESSEE; damage items immutable; the transition matrix.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-rules-eot.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { addMonthsClamped, dbDate, fromDayNumber, toDayNumber } from "./dates"
import { appendLeaseCharge } from "./lease-charges"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, ruleAdmits, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
/** expired: its term ends today; ended: a month ago; running: years away; advance: in advance, its last rental due today. */
const loans = { expired: "", ended: "", running: "", advance: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const today = () => sastCalendarDate(new Date())
const day = (offset: number) => fromDayNumber(toDayNumber(today()) + offset)
const G = "guardLeaseEndOfTerm"
const PV = "purchaseValuationOk" // the purchase valuation rule, shared by the election and a re-basing

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const refuses = (rule: Parameters<typeof ruleRefuses>[1], message: RegExp, attack: (tx: Tx) => Promise<unknown>) => ruleRefuses(database(), rule, message, attack)
const without = (fn: string, clause: string, replacement = "") => ({ fn, replace: [clause, replacement] as const })

async function book(assetId: string, timing: "ADVANCE" | "ARREARS", periods: number, months: number): Promise<string> {
  const firstDue = addMonthsClamped(today(), 1)
  const dealId = await approveLease(fx, staff, leaseBody(fx, {
    assetId, contractType: "OPERATING_LEASE", rentalTiming: timing, entityId: fx.evidenced, preset: { kind: "MONTHLY", periods }, balloonCents: 100_000_000, firstDueDate: firstDue,
  }))
  await signLease(fx, database(), setSession, dealId, timing === "ADVANCE" ? firstDue : undefined)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  await backdateLease(database(), loanId, months)
  return loanId
}

const assetOf = (loanId: string) => database().loan.findUniqueOrThrow({ where: { id: loanId } }).then((l) => l.assetId ?? "")
const elect = (tx: Tx, loanId: string, data: Record<string, unknown> = {}) => tx.leaseEndOfTerm.create({
  data: { tenantId: fx.tenantId, loanId, origin: "EXPIRY", outcome: "RETURN", status: "ELECTED", electedById: fx.officer, ...data }, select: { id: true },
})
const electedDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const inspect = (tx: Tx, id: string, inspectedOn: string, data: Record<string, unknown> = {}) => tx.leaseEndOfTerm.update({
  where: { id }, data: { status: "INSPECTED", inspectedOn: dbDate(inspectedOn), inspectedById: fx.officer, inspectionCondition: "Synthetic: scratched", ...data },
})
const inspected = async (tx: Tx, loanId: string) => {
  const { id } = await elect(tx, loanId)
  await inspect(tx, id, today())
  return id
}
const extending = (tx: Tx, loanId: string, electedAt = new Date()) => elect(tx, loanId, { outcome: "EXTEND", status: "EXTENDING", electedAt })
const notice = (tx: Tx, id: string, noticeOn: string, endsOn: string | null) => tx.leaseEndOfTerm.update({
  where: { id }, data: { extensionNoticeOn: dbDate(noticeOn), extensionEndsOn: endsOn === null ? null : dbDate(endsOn) },
})
const reading = (tx: Tx, assetId: string, loanId: string | null, readingDate: string, value: number) => tx.assetMeterReading.create({
  data: { tenantId: fx.tenantId, assetId, loanId, readingDate: dbDate(readingDate), value, unit: "HOURS", source: "STAFF", recordedById: fx.officer }, select: { id: true },
})
const valuation = async (tx: Tx, loanId: string, data: { valuedOn?: string; source?: "ASSESSOR" | "DEALER" | "INTERNAL"; by?: string } = {}) => tx.assetValuation.create({
  data: {
    tenantId: fx.tenantId, assetId: await assetOf(loanId), valuedOn: dbDate(data.valuedOn ?? today()), source: data.source ?? "ASSESSOR",
    valuerName: "TEST Assessors", amountCents: 50_000_000, createdById: data.by ?? fx.adminB,
  },
  select: { id: true },
})
const purchase = async (tx: Tx, loanId: string, v: Parameters<typeof valuation>[2] = {}, electedById: string | null = fx.officer) =>
  elect(tx, loanId, { outcome: "PURCHASE", purchasePriceExclVatCents: 50_000_000, purchaseValuationId: (await valuation(tx, loanId, v)).id, electedById })
/** The real sale-invoice path, in `tx`: the tax invoice, its charge row, linked. */
async function saleInvoiced(tx: Tx, loanId: string, id: string) {
  const invoice = await issueTaxInvoice(tx as never, {
    tenantId: fx.tenantId, loanId, issueDate: today(), supplyDate: today(), createdById: fx.adminA,
    recipient: { name: "TEST Lessee (Pty) Ltd", address: "9 Synthetic Yard, Johannesburg, 2001", vatNumber: null },
    lines: [{ description: "Sale of a synthetic asset", quantity: 1, unitExclVatCents: 50_000_000 }],
  })
  const scheduleId = await appendLeaseCharge(tx as never, { tenantId: fx.tenantId, loanId, amountCents: invoice.totalInclVatCents, dueDate: today(), actorUserId: fx.adminA, why: "test" })
  await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "INVOICED", taxInvoiceId: invoice.id, scheduleId } })
}
const TIMING = /from the day the asset comes back/
const NOTICE = /Notice is given between the election and today/
const MARKET = /at least the asset's market value/

suite.sequential("lease servicing rules: end of term, clause by clause (each clause removed → the attack goes through)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    loans.expired = await book(fx.assets[1], "ARREARS", 2, 2)
    loans.ended = await book(fx.assets[2], "ARREARS", 2, 3)
    loans.running = await book(fx.assets[3], "ARREARS", 36, 2)
    loans.advance = await book(fx.assets[0], "ADVANCE", 2, 2)
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("timing, expiry in arrears: inspected from the last rental's due date (on it: admitted)", async () => {
    await ruleAdmits(database(), (tx) => inspected(tx, loans.expired))
    await refuses(without(G, ` OR NEW."inspectedOn" < returns_on`), TIMING, (tx) => inspected(tx, loans.running))
  })

  it("timing, expiry in advance: the term ends a month after the last rental", async () => {
    await refuses(without("leaseTermEnd", `(MAX(r."dueDate") + INTERVAL '1 month')::date`, `MAX(r."dueDate")`), TIMING, (tx) => inspected(tx, loans.advance))
  })

  it("timing, early termination: inspected from the accepted quote's termination date", async () => {
    await refuses(without(G, `WHEN NEW."origin" = 'EARLY_TERMINATION' THEN`, "WHEN FALSE THEN"), TIMING, async (tx) => {
      const quote = await tx.leaseTerminationQuote.create({
        data: {
          tenantId: fx.tenantId, loanId: loans.expired, quotedOn: dbDate(today()), terminationDate: dbDate(day(5)), validUntil: dbDate(today()), cpaCancellation: false,
          remainingRentals: 0, pvCents: 0, penaltyCents: 0, arrearsCents: 1, invoiceExclVatCents: 0, invoiceVatCents: 0, totalCents: 1, basis: "Synthetic basis for a test",
        },
      })
      await tx.leaseTerminationQuote.update({ where: { id: quote.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: fx.adminA } })
      await inspect(tx, (await elect(tx, loans.expired, { origin: "EARLY_TERMINATION" })).id, today())
    })
  })

  it("timing, extension: inspected from the extension's end", async () => {
    await refuses(without(G, `WHEN NEW."outcome" = 'EXTEND' THEN NEW."extensionEndsOn"`, `WHEN FALSE THEN NEW."extensionEndsOn"`), TIMING, async (tx) => {
      const { id } = await extending(tx, loans.ended, electedDaysAgo(60))
      await notice(tx, id, day(-40), today())
      await inspect(tx, id, day(-1))
    })
  })

  it("timing: never in the future, never before the election", async () => {
    await refuses(without(G, ` OR NEW."inspectedOn" > today`), TIMING, async (tx) => inspect(tx, (await elect(tx, loans.expired)).id, day(1)))
    await refuses(without(G, `OR NEW."inspectedOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date`), TIMING,
      async (tx) => inspect(tx, (await elect(tx, loans.ended)).id, day(-1)))
  })

  it("the final reading is the lease's asset's, dated the inspection, and the latest", async () => {
    const FINAL = /final reading is the lease's asset's latest/
    await refuses(without(G, ` AND m."assetId" = loan_row."assetId"`), FINAL, async (tx) => {
      const other = await reading(tx, await assetOf(loans.running), null, today(), 10)
      await inspect(tx, (await elect(tx, loans.expired)).id, today(), { finalReadingId: other.id })
    })
    await refuses(without(G, ` AND m."readingDate" = NEW."inspectedOn"`), FINAL, async (tx) => {
      const earlier = await reading(tx, await assetOf(loans.expired), loans.expired, day(-1), 10)
      await inspect(tx, (await elect(tx, loans.expired)).id, today(), { finalReadingId: earlier.id })
    })
    await refuses(without(G, `AND x."readingDate" > m."readingDate"`, "AND FALSE"), FINAL, async (tx) => {
      const asset = await assetOf(loans.ended)
      const final = await reading(tx, asset, loans.ended, day(-1), 10)
      await reading(tx, asset, loans.ended, today(), 20)
      await inspect(tx, (await elect(tx, loans.ended, { electedAt: electedDaysAgo(10) })).id, day(-1), { finalReadingId: final.id })
    })
  })

  it("extension notice: between the election and today, with an end at least a month later", async () => {
    const give = (noticeOn: string, endsOn: string | null) => async (tx: Tx) => notice(tx, (await extending(tx, loans.expired)).id, noticeOn, endsOn)
    await ruleAdmits(database(), give(today(), addMonthsClamped(today(), 1)))
    await refuses(without(G, `OR NEW."extensionNoticeOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date`), NOTICE, give(day(-1), day(60)))
    await refuses(without(G, `OR NEW."extensionNoticeOn" > today`), NOTICE, give(day(1), day(60)))
    await refuses(without(G, `OR NEW."extensionEndsOn" IS NULL`), NOTICE, give(today(), null))
    await refuses(without(G, `OR NEW."extensionEndsOn" < (NEW."extensionNoticeOn" + INTERVAL '1 month')::date`), NOTICE, give(today(), day(7)))
    // Never before the billed period ends (a running lease: its term runs years on).
    await refuses(without(G, `
      OR NEW."extensionEndsOn" < public."leaseTermEnd"(NEW."loanId", NEW."tenantId")`), NOTICE,
      async (tx) => notice(tx, (await extending(tx, loans.running)).id, today(), day(40)))
  })

  it("the extension's end, and the billed figures once invoiced, are fixed", async () => {
    const FIXED = /fixed once set/
    await refuses(without(G, `OR (OLD."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM OLD."extensionEndsOn")`), FIXED, async (tx) => {
      const { id } = await extending(tx, loans.expired)
      await notice(tx, id, today(), day(40))
      await tx.leaseEndOfTerm.update({ where: { id }, data: { extensionEndsOn: dbDate(day(50)) } })
    })
    const frozen = without(G, `OLD."status" IN ('INVOICED', 'COMPLETED') AND (NEW."excessUsageCents"`, `FALSE AND (NEW."excessUsageCents"`)
    for (const data of [{ excessUsageCents: 5 }, { fundSettlementCents: 5 }]) {
      await refuses(frozen, FIXED, async (tx) => {
        const id = await inspected(tx, loans.expired)
        await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "INVOICED" } })
        await tx.leaseEndOfTerm.update({ where: { id }, data })
      })
    }
  })

  it("a purchase rests on an assessor's or dealer's valuation, recorded by someone other than the elector, within the tenant's age", async () => {
    await ruleAdmits(database(), (tx) => purchase(tx, loans.expired, { valuedOn: day(-30) })) // exactly the maximum age (30 days)
    await ruleAdmits(database(), (tx) => purchase(tx, loans.expired, { by: fx.officer }, null)) // the lessee elects in the portal
    await refuses(without(PV, ` AND v."source" IN ('ASSESSOR', 'DEALER')`), MARKET, (tx) => purchase(tx, loans.expired, { source: "INTERNAL" }))
    await refuses(without(PV, ` AND (elector_id IS NULL OR v."createdById" IS DISTINCT FROM elector_id)`), MARKET,
      (tx) => purchase(tx, loans.expired, { by: fx.officer }))
    await refuses(without(PV, `v."valuedOn" >= (now() AT TIME ZONE 'Africa/Johannesburg')::date - max_age AND `), MARKET, (tx) => purchase(tx, loans.expired, { valuedOn: day(-31) }))
  })

  it("an elected purchase is re-based only on a valuation that passes the same rule", async () => {
    const rebase = async (tx: Tx, v: Parameters<typeof valuation>[2]) => {
      const { id } = await purchase(tx, loans.expired)
      await tx.leaseEndOfTerm.update({ where: { id }, data: { purchaseValuationId: (await valuation(tx, loans.expired, v)).id } })
    }
    await ruleAdmits(database(), (tx) => rebase(tx, {})) // a current assessor's valuation by someone else
    await refuses(without(G, `OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId")
     AND NOT public."purchaseValuationOk"`, `OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId")
     AND FALSE AND NOT public."purchaseValuationOk"`), MARKET, (tx) => rebase(tx, { source: "INTERNAL" }))
  })

  it("a purchase is sale-invoiced once the term ends, on a valuation still current", async () => {
    const SALE = /invoiced when the term ends, on a current valuation/
    await ruleAdmits(database(), async (tx) => saleInvoiced(tx, loans.expired, (await purchase(tx, loans.expired)).id))
    await refuses(without(G, `today < public."leaseTermEnd"(NEW."loanId", NEW."tenantId") OR `), SALE,
      async (tx) => saleInvoiced(tx, loans.running, (await purchase(tx, loans.running)).id))
    await refuses(without(G, ` OR valuation."valuedOn" < today - max_age THEN`, " THEN"), SALE, async (tx) => {
      const { id } = await purchase(tx, loans.expired, { valuedOn: day(-20) })
      await tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { leasePurchaseValuationMaxAgeDays: 10 } })
      await saleInvoiced(tx, loans.expired, id)
    })
  })

  it("an end of term completes once everything owed is paid; an asset is SOLD_TO_LESSEE only by a completed purchase", async () => {
    await refuses(without(G, `r."totalPaid" < r."totalDue"`, "FALSE"), /completes once everything owed on the lease is paid/, async (tx) => {
      const id = await inspected(tx, loans.expired)
      await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "INVOICED" } })
      await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } })
    })
    await refuses(without("guardAssetLessorStatus", `IF NEW."lessorStatus" = 'SOLD_TO_LESSEE' AND OLD."lessorStatus" IS DISTINCT FROM NEW."lessorStatus" AND NOT EXISTS (`, "IF FALSE AND NOT EXISTS ("),
      /sold to the lessee by a completed purchase/,
      async (tx) => tx.financedAsset.update({ where: { id: await assetOf(loans.expired) }, data: { lessorStatus: "SOLD_TO_LESSEE", lessorStatusAt: new Date() } }))
  })

  it("a damage item is immutable: never updated, never deleted", async () => {
    const item = async (tx: Tx) => tx.leaseDamageItem.create({ data: { tenantId: fx.tenantId, endOfTermId: await inspected(tx, loans.expired), description: "Synthetic dent", amountExclVatCents: 1_000 } })
    const rule = { table: "LeaseDamageItem", trigger: "LeaseDamageItem_guard" }
    await refuses(rule, /damage item is immutable/, async (tx) => tx.leaseDamageItem.update({ where: { id: (await item(tx)).id }, data: { amountExclVatCents: 1 } }))
    await refuses(rule, /damage item is immutable/, async (tx) => tx.leaseDamageItem.delete({ where: { id: (await item(tx)).id } }))
  })

  it("the transition matrix: a return, and an extension, is inspected before it is invoiced", async () => {
    const matrix = without(G, `IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (`, "IF FALSE AND NOT (")
    const invoicedAt = (inspectedOn: string) => ({ status: "INVOICED" as const, inspectedOn: dbDate(inspectedOn), inspectedById: fx.officer, inspectionCondition: "Synthetic: fine" })
    await refuses(matrix, /RETURN end of term cannot move from ELECTED to INVOICED/,
      async (tx) => tx.leaseEndOfTerm.update({ where: { id: (await elect(tx, loans.expired)).id }, data: invoicedAt(today()) }))
    await refuses(matrix, /EXTEND end of term cannot move from EXTENDING to INVOICED/,
      async (tx) => tx.leaseEndOfTerm.update({ where: { id: (await extending(tx, loans.expired)).id }, data: invoicedAt(today()) }))
  })
})
