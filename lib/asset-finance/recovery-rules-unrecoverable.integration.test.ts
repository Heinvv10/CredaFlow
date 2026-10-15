/**
 * Slice 4a costs the loan's ledger could not carry (migration 20261015400000),
 * each proved as in the lease suites: the attack is refused, and goes through
 * with that one statement, clause or CHECK taken out, inside a rolled-back
 * transaction. Recovery.unrecoverableCostsCents is the part of the charged
 * costs that could not be put on the ledger: set once, NULL to a value, with
 * the proceeds or after them while the status is PROCEEDS_APPLIED, never more
 * than the charged costs or the shortfall; what is still owed is the shortfall
 * less it, and a shortfall opens only when that is positive, a recovery closes
 * from its proceeds only when it is nil and there is no surplus.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-unrecoverable.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { advance, ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newLoan, newRecovery, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { clauseOff, raiseOff, rules, triggersOff, type Tx } from "./recovery-rules.integration-fixture"

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
const G = "guardRecovery"
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
const R = {} as Record<"ncaProc" | "owing" | "owedNil" | "owingSet" | "fni" | "sold" | "listed" | "shortfallOpen", Rec>
const CHARGED = 2_000_000
const charged = [{ type: "LEGAL_CONTRACTUAL" as const, treatment: "CHARGE_TO_ACCOUNT" as const, grossCents: CHARGED }]
const set = (rec: Rec, value: number | null, over: Record<string, unknown> = {}) => (tx: Tx) =>
  tx.recovery.update({ where: { id: rec.id }, data: { unrecoverableCostsCents: value, ...over } })
const move = (rec: Rec, status: "SHORTFALL_OPEN" | "CLOSED") => (tx: Tx) =>
  tx.recovery.update({ where: { id: rec.id }, data: { status, ...(status === "CLOSED" ? { closedAt: new Date() } : {}) } })

suite("slice 4a the costs the loan's ledger could not carry", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    // settlement R1 500 000, price R1 200 000, charged R20 000: shortfall R320 000, unset
    R.owing = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED", { costs: charged, unrecoverableCents: null })
    // settlement = the price, so the shortfall is only the charged costs: R20 000, unset
    R.owedNil = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED", { costs: charged, settlementCents: 120_000_000, unrecoverableCents: null })
    R.owingSet = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED", { costs: charged, unrecoverableCents: 500_000 })
    R.ncaProc = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED", { unrecoverableCents: null })
    // a final notice issued with the figure unset can no longer happen through the guard: the state is built with triggers off
    const unset = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED", { unrecoverableCents: null })
    await testSetup(database(), [`UPDATE "Recovery" SET "status" = 'FINAL_NOTICE_ISSUED', "finalNoticeIssuedOn" = CURRENT_DATE, "chargesFrozenUntil" = CURRENT_DATE + 14 WHERE "id" = $1`, unset.id])
    R.fni = unset
    R.sold = await ladderRecovery(database(), fx, false, "SOLD", { costs: charged })
    R.listed = await ladderRecovery(database(), fx, false, "LISTED")
    R.shortfallOpen = await ladderRecovery(database(), fx, false, "SHORTFALL_OPEN", { costs: charged, unrecoverableCents: 500_000 })
  }, 600_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("the value", () => {
    const check = { table: "Recovery", constraint: "Recovery_unrecoverable_costs" }
    it("is no more than the charged costs, no more than the shortfall, and not negative", async () => {
      await refuses(check, /Recovery_unrecoverable_costs/, set(R.owing, CHARGED + 1))
      await refuses(check, /Recovery_unrecoverable_costs/, set(R.owing, -1))
      await refuses(check, /Recovery_unrecoverable_costs/, set(R.owedNil, CHARGED + 1))
      await admits(set(R.owing, CHARGED))
      await admits(set(R.owedNil, CHARGED))
      await admits(set(R.owing, 0))
    })

    it("can only be set with the figures it is a part of", async () => {
      await refuses(check, /Recovery_unrecoverable_costs/, async (tx) => {
        await triggersOff(tx)
        await tx.recovery.update({ where: { id: R.listed.id }, data: { unrecoverableCostsCents: 0 } })
      })
    })
  })

  describe("it is written once, NULL to a value", () => {
    const writeOnce = clauseOff(G, `IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN`, "IF false THEN")
    it("with the proceeds, or after them while the status is PROCEEDS_APPLIED", async () => {
      await admits(set(R.owing, 0))
      // with the proceeds: the path set it (0) in the SOLD to PROCEEDS_APPLIED step
      await admits(set(R.owingSet, 500_000, { location: "TEST Other Yard" }))
    })

    it("and then never changed", async () => {
      await refuses(writeOnce, /write-once/, set(R.owingSet, 600_000))
      await refuses(writeOnce, /write-once/, set(R.owingSet, null))
    })

    it("and in no other status", async () => {
      await refuses(writeOnce, /write-once/, set(R.fni, 0)) // FINAL_NOTICE_ISSUED
      await refuses(writeOnce, /write-once/, set(R.shortfallOpen, 400_000)) // SHORTFALL_OPEN
    })

    it("and not by a step that is not the proceeds (here the final notice)", async () => {
      await refuses(writeOnce, /write-once/, (tx) => tx.recovery.update({
        where: { id: R.ncaProc.id },
        data: {
          status: "FINAL_NOTICE_ISSUED", finalNoticeIssuedOn: dbDate(today()), finalNoticePath: "/nonexistent/fn.pdf", finalNoticeSha256: "c".repeat(64),
          chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(today(), 10)), unrecoverableCostsCents: 0,
        },
      }))
    })
  })

  describe("a shortfall opens for what is still owed", () => {
    const message = /A shortfall is open for a positive shortfall with its freeze end set/
    it("only once it is recorded", async () => {
      await refuses(raiseOff(G, "The costs the loan's ledger could not carry are recorded before a shortfall is opened"), /recorded before a shortfall is opened/, move(R.owing, "SHORTFALL_OPEN"),
        [clauseOff(G, `IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN`, "IF false THEN")])
    })

    it("only when the shortfall less the unrecoverable costs is positive", async () => {
      const owed = clauseOff(G, `IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN`, "IF false THEN")
      await refuses(owed, message, async (tx) => { await set(R.owedNil, CHARGED)(tx); await move(R.owedNil, "SHORTFALL_OPEN")(tx) })
      await admits(async (tx) => { await set(R.owing, CHARGED)(tx); await move(R.owing, "SHORTFALL_OPEN")(tx) })
      await admits(async (tx) => { await set(R.owedNil, 0)(tx); await move(R.owedNil, "SHORTFALL_OPEN")(tx) })
    })
  })

  describe("a recovery closes from its proceeds when nothing is owed and nothing is held", () => {
    const message = /closes straight from its proceeds only with no shortfall and no surplus/
    const owedRule = clauseOff(G, `IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <> 0 OR NEW."surplusCents" <> 0 THEN`, "IF false THEN")
    it("only once the unrecoverable costs are recorded", async () => {
      await refuses(raiseOff(G, "The costs the loan's ledger could not carry are recorded before the recovery closes"), /recorded before the recovery closes/, move(R.owedNil, "CLOSED"), [owedRule])
    })

    it("when the shortfall is all costs the ledger could not carry, and not when something is still owed", async () => {
      await admits(async (tx) => { await set(R.owedNil, CHARGED)(tx); await move(R.owedNil, "CLOSED")(tx) })
      await refuses(owedRule, message, async (tx) => { await set(R.owedNil, 0)(tx); await move(R.owedNil, "CLOSED")(tx) })
      await refuses(owedRule, message, async (tx) => { await set(R.owing, CHARGED)(tx); await move(R.owing, "CLOSED")(tx) })
    })
  })

  it("leaves a shortfall's close unchanged: when the loan is settled or written off", async () => {
    await refuses(raiseOff(G, "A shortfall closes when the loan is settled or written off"), /shortfall closes when the loan is settled or written off/, move(R.shortfallOpen, "CLOSED"))
  })

  it("is written at the proceeds step of a fresh recovery (the path of a sold recovery)", async () => {
    const loan = await newLoan(database(), fx, "NON_NCA")
    const id = await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY")
    await advance(database(), fx, loan, id, "PROCEEDS_APPLIED", { costs: charged, unrecoverableCents: 700_000 })
    await admits(async (tx) => {
      const row = await tx.recovery.findUniqueOrThrow({ where: { id }, select: { unrecoverableCostsCents: true } })
      if (row.unrecoverableCostsCents !== 700_000) throw new Error("not written with the proceeds")
    })
  })
})
