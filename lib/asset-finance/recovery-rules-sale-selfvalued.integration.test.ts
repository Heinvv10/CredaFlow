/**
 * Slice 4a self-valued sales (migration 20261015400000), each proved as in the
 * lease suites: the attack is refused or its flag is forced, and the same sale
 * with that one clause taken out of guardRemarketingSale (or the CHECK dropped)
 * goes through unflagged, inside a rolled-back transaction. A sale whose
 * proposer recorded the valuation it relies on, or the highest current
 * independent one (a tie counts), is flagged selfValued by the trigger and
 * completes only with a second approver; a valuation the proposer records after
 * the sale was proposed forces it to be re-recorded. The valuation-independence
 * policy is UNTESTED against the lender's own.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-sale-selfvalued.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { attempt } from "./lease-servicing.integration-fixture"
import { advance, saleData } from "./recovery-path.integration-fixture"
import {
  recordFixtureCommercialCancellation, cleanupRecoveryFixture, createRecoveryFixture, newLoan, newRecovery, newValuation, recoveryFixtureTenantId, saleInvoice, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { clauseOff, raiseOff, rules, takeOut, type Tx } from "./recovery-rules.integration-fixture"

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
interface Rec { loan: RecoveryLoan; id: string; reliedOn: string }
const R = {} as Record<"relies" | "highest" | "tie" | "clean", Rec>
let invoice = ""

/** A recovery LISTED on admin A's valuation of R1 000 000, and the officer's further valuations of it (the officer proposes every sale); a sale relies on the officer's when asked, else on admin A's. */
async function listed(officerValuations: number[], reliesOnOfficers = false): Promise<Rec> {
  const loan = await newLoan(database(), fx, "NON_NCA")
  const id = await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY")
  await advance(database(), fx, loan, id, "LISTED", { valuationCents: 100_000_000 })
  let reliedOn = (await database().assetValuation.findFirstOrThrow({ where: { assetId: loan.assetId } })).id
  for (const amount of officerValuations) {
    const officers = await newValuation(database(), fx, loan.assetId, amount, "ASSESSOR", today(), fx.officer)
    if (reliesOnOfficers) reliedOn = officers
  }
  await recordFixtureCommercialCancellation(database(), fx, loan.loanId)
  return { loan, id, reliedOn }
}
const saleIn = async (tx: Tx, r: Rec, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.create({ data: { ...(await saleData(database(), fx, r.loan, r.id)), valuationId: r.reliedOn, ...over } as never })
/** The flag the trigger left on a new sale (the attack is rolled back), with the rules given taken out. */
async function flag(r: Rec, ...without: NonNullable<Parameters<typeof attempt>[2]>[]): Promise<boolean> {
  let seen: boolean | undefined
  const result = await attempt(database(), async (tx) => {
    for (const rule of without) await takeOut(tx, rule)
    seen = (await saleIn(tx, r)).selfValued
  })
  expect(result).toBe("ok")
  return seen as unknown as boolean
}
const complete = (tx: Tx, id: string, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: invoice, ...over } })
const approve = (tx: Tx, id: string, by: string) => tx.remarketingSale.update({ where: { id }, data: { approvedById: by, approvedAt: new Date() } })

suite("slice 4a a sale on a valuation its proposer recorded", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    invoice = await saleInvoice(database(), fx)
    R.relies = await listed([90_000_000], true) // relies on the officer's R900 000; the highest, admin A's R1 000 000, is not theirs
    R.highest = await listed([110_000_000]) // relies on admin A's; the highest, R1 100 000, is the officer's
    R.tie = await listed([100_000_000]) // admin A's and the officer's tie for highest
    R.clean = await listed([]) // admin A's alone
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  const relied = clauseOff(G, `EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."createdById" = NEW."createdById")`, "false")
  const highest = clauseOff(G, `AND v."amountCents" = highest AND v."createdById" = NEW."createdById"`, "AND false")
  const noTie = clauseOff(G, `AND v."amountCents" = highest AND`, `AND v."amountCents" > highest AND`)

  it("is flagged when the proposer recorded the valuation the sale relies on", async () => {
    expect(await flag(R.relies)).toBe(true)
    expect(await flag(R.relies, relied)).toBe(false)
  })

  it("is flagged when the proposer recorded the highest current valuation", async () => {
    expect(await flag(R.highest)).toBe(true)
    expect(await flag(R.highest, highest)).toBe(false)
  })

  it("counts a tie for highest as the proposer's", async () => {
    expect(await flag(R.tie)).toBe(true)
    expect(await flag(R.tie, noTie)).toBe(false)
  })

  it("is not flagged when someone else recorded every valuation it rests on", async () => {
    expect(await flag(R.clean)).toBe(false)
  })

  it("completes only with a second approver, someone other than the proposer", async () => {
    const check = { table: "RemarketingSale", constraint: "RemarketingSale_second_approver" }
    await refuses(check, /RemarketingSale_second_approver/, async (tx) => complete(tx, (await saleIn(tx, R.highest)).id))
    await refuses(check, /RemarketingSale_second_approver/, async (tx) => { const id = (await saleIn(tx, R.highest)).id; await approve(tx, id, fx.officer); await complete(tx, id) })
    await admits(async (tx) => { const id = (await saleIn(tx, R.highest)).id; await approve(tx, id, fx.adminB); await complete(tx, id) })
    await admits(async (tx) => complete(tx, (await saleIn(tx, R.clean)).id))
  })

  it("is re-recorded when the proposer records the highest valuation after proposing", async () => {
    await refuses(raiseOff(G, "A sale on a valuation its proposer recorded needs the sale re-recorded as self-valued"), /needs the sale re-recorded as self-valued/, async (tx) => {
      const id = (await saleIn(tx, R.clean)).id
      await tx.assetValuation.create({
        data: { tenantId: fx.tenantId, assetId: R.clean.loan.assetId, valuedOn: dbDate(today()), source: "ASSESSOR", valuerName: "TEST Valuers", amountCents: 120_000_000, createdById: fx.officer },
      })
      await complete(tx, id)
    })
  })
})
