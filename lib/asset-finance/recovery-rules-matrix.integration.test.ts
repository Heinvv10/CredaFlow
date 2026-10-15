/**
 * Slice 4a recovery rules, part 2 (migration 20261015400000): the status
 * matrix and what each early step needs. A recovery is committed at every
 * status of both families (NCA s131, NON_NCA voluntary) through the real
 * guards; then every status-to-status attack is classified (a legal edge is
 * never refused by the matrix, any other always is), and each step's own
 * requirement is proved as in the lease suites: the attack is refused, and goes
 * through with that one statement or clause taken out, in a rolled-back
 * transaction. Where a second rule would refuse the same attack (defence in
 * depth), it is taken out too. Legal rules are UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-matrix.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type RecoveryStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { advance, saleData } from "./recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, courtMatter, createRecoveryFixture, newLoan, newRecovery, newSurrender, newValuation, recoveryFixtureTenantId, saleInvoice,
  type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

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
const { refuses, admits, refusal } = rules(database)
const G = "guardRecovery"
let fx: RecoveryFixture

const ALL: RecoveryStatus[] = ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED", "SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED", "WITHDRAWN"]
const NCA_STATUSES = ALL
const NON_NCA_STATUSES = ALL.filter((s) => s !== "VALUATION_NOTICE_ISSUED" && s !== "FINAL_NOTICE_ISSUED")
/** The edges of the matrix (SLICE4.md); everything else is refused. */
const LEGAL: Record<"nca" | "non", [RecoveryStatus, RecoveryStatus][]> = {
  nca: [
    ["RECOVERED", "VALUED"], ["VALUED", "VALUATION_NOTICE_ISSUED"], ["VALUATION_NOTICE_ISSUED", "LISTED"], ["LISTED", "SOLD"], ["SOLD", "PROCEEDS_APPLIED"],
    ["PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED"], ["FINAL_NOTICE_ISSUED", "SHORTFALL_OPEN"], ["FINAL_NOTICE_ISSUED", "SURPLUS_HELD"], ["FINAL_NOTICE_ISSUED", "CLOSED"],
    ["SHORTFALL_OPEN", "CLOSED"], ["SURPLUS_HELD", "CLOSED"], ["RECOVERED", "WITHDRAWN"], ["VALUED", "WITHDRAWN"], ["VALUATION_NOTICE_ISSUED", "WITHDRAWN"], ["LISTED", "WITHDRAWN"],
  ],
  non: [
    ["RECOVERED", "VALUED"], ["VALUED", "LISTED"], ["LISTED", "SOLD"], ["SOLD", "PROCEEDS_APPLIED"], ["PROCEEDS_APPLIED", "SHORTFALL_OPEN"], ["PROCEEDS_APPLIED", "SURPLUS_HELD"],
    ["PROCEEDS_APPLIED", "CLOSED"], ["SHORTFALL_OPEN", "CLOSED"], ["SURPLUS_HELD", "CLOSED"], ["RECOVERED", "WITHDRAWN"], ["VALUED", "WITHDRAWN"], ["LISTED", "WITHDRAWN"],
  ],
}
const MATRIX_REFUSAL = /cannot go from|is final|listed only after|Only an NCA recovery|gives its final notice before/

const at = { nca: {}, non: {} } as Record<"nca" | "non", Partial<Record<RecoveryStatus, { loan: RecoveryLoan; id: string }>>>
/** A NON_NCA recovery whose sale is complete but not yet SOLD (LISTED), and an NCA s127 one at VALUED with a surrender valued by `valuation`. */
let listedSold: { loan: RecoveryLoan; id: string }
let s127: { loan: RecoveryLoan; id: string; surrenderId: string; valuation: string }

async function ladder(family: "nca" | "non", to: RecoveryStatus) {
  const nca = family === "nca"
  const loan = await newLoan(database(), fx, nca ? "NCA" : "NON_NCA")
  const id = await newRecovery(database(), fx, loan, nca ? "NCA_S131_ATTACHMENT" : "NON_NCA_VOLUNTARY", nca ? { legalMatterId: await courtMatter(database(), fx, loan) } : {})
  // surplus: the settlement is below the net proceeds; closed: nothing owed
  const settlementCents = to === "SURPLUS_HELD" ? 80_000_000 : to === "CLOSED" ? 120_000_000 : undefined
  await advance(database(), fx, loan, id, to, { settlementCents })
  return { loan, id }
}

suite("slice 4a recovery database rules: the status matrix", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    for (const family of ["nca", "non"] as const) {
      for (const status of family === "nca" ? NCA_STATUSES : NON_NCA_STATUSES) at[family][status] = await ladder(family, status)
    }
    listedSold = await ladder("non", "LISTED")
    const sale = await database().remarketingSale.create({ data: await saleData(database(), fx, listedSold.loan, listedSold.id) })
    await database().remarketingSale.update({ where: { id: sale.id }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: await saleInvoice(database(), fx) } })
    const loan = await newLoan(database(), fx, "NCA")
    const surrenderId = await newSurrender(database(), fx, loan)
    const id = await newRecovery(database(), fx, loan, "NCA_S127_SURRENDER", { surrenderRequestId: surrenderId })
    const valuation = await newValuation(database(), fx, loan.assetId)
    await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status" = 'VALUED', "valuationId" = $1 WHERE "id" = $2`, valuation, surrenderId])
    s127 = { loan, id, surrenderId, valuation }
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  const move = (family: "nca" | "non", from: RecoveryStatus, to: RecoveryStatus) =>
    (tx: Tx) => tx.recovery.update({ where: { id: at[family][from]!.id }, data: { status: to } })

  describe.each([["nca", NCA_STATUSES], ["non", NON_NCA_STATUSES]] as const)("%s family", (family, statuses) => {
    it("refuses every status step that is not on the matrix, and the matrix never refuses one that is", async () => {
      const legal = new Set(LEGAL[family].map(([from, to]) => `${from}>${to}`))
      const wrongly: string[] = []
      for (const from of statuses) {
        for (const to of ALL) {
          if (from === to) continue
          const result = await refusal(move(family, from, to))
          const refusedByMatrix = MATRIX_REFUSAL.test(result)
          if (legal.has(`${from}>${to}`) === refusedByMatrix) wrongly.push(`${from}>${to}: ${result.slice(0, 160)}`)
        }
      }
      expect(wrongly).toEqual([])
    }, 120_000)
  })

  it("is the matrix that refuses a step off it (skipping, going back, jumping to the end)", async () => {
    const rule = { fn: G, replace: [`RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A recovery cannot go from %s to %s', OLD."status", NEW."status");`, `allowed := ARRAY[]::TEXT[];`] as const }
    await refuses(rule, /cannot go from RECOVERED to LISTED/, move("non", "RECOVERED", "LISTED"))
    await refuses(rule, /cannot go from LISTED to VALUED/, move("non", "LISTED", "VALUED"))
    await refuses(rule, /cannot go from VALUED to PROCEEDS_APPLIED/, move("non", "VALUED", "PROCEEDS_APPLIED"))
  })

  it("is final once closed or withdrawn", async () => {
    const rule = raiseOff(G, "A closed or withdrawn recovery is final")
    const touch = (family: "nca" | "non", status: RecoveryStatus) => (tx: Tx) => tx.recovery.update({ where: { id: at[family][status]!.id }, data: { location: "TEST Elsewhere" } })
    await refuses(rule, /is final/, touch("non", "CLOSED"))
    await refuses(rule, /is final/, touch("nca", "WITHDRAWN"))
    await admits(touch("nca", "SHORTFALL_OPEN"))
  })

  describe("the route rules of the matrix", () => {
    it("lets only an NCA recovery issue a valuation or final notice", async () => {
      const rule = raiseOff(G, "Only an NCA recovery issues a valuation or final notice")
      await refuses(rule, /Only an NCA recovery issues/, move("non", "VALUED", "VALUATION_NOTICE_ISSUED"), [raiseOff(G, "An s131 valuation notice is stored with its digest")])
      await refuses(rule, /Only an NCA recovery issues/, move("non", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED"),
        [
          raiseOff(G, "The final notice is dated from the proceeds to today"), raiseOff(G, "Charges stay frozen until 10 business days after the final notice"),
          raiseOff(G, "An s131 final notice is stored with its digest"),
        ])
    })

    it("lists an NCA recovery only after its valuation notice, a NON_NCA one straight from its valuation", async () => {
      await refuses(raiseOff(G, "An NCA recovery is listed only after its valuation notice"), /listed only after its valuation notice/, move("nca", "VALUED", "LISTED"))
      await admits(move("non", "VALUED", "LISTED"))
    })

    it("opens the shortfall, surplus or closure of an NCA recovery only after its final notice", async () => {
      const rule = raiseOff(G, "An NCA recovery gives its final notice before the shortfall or surplus is opened")
      const message = /gives its final notice before the shortfall or surplus is opened/
      await refuses(rule, message, move("nca", "PROCEEDS_APPLIED", "SHORTFALL_OPEN"), [raiseOff(G, "A shortfall is open for a positive shortfall with its freeze end set")])
      await refuses(rule, message, move("nca", "PROCEEDS_APPLIED", "SURPLUS_HELD"), [raiseOff(G, "A surplus is held for a positive surplus")])
      await refuses(rule, message, (tx) => tx.recovery.update({ where: { id: at.nca.PROCEEDS_APPLIED!.id }, data: { status: "CLOSED", closedAt: new Date() } }),
        [raiseOff(G, "A recovery closes straight from its proceeds only with no shortfall and no surplus")])
    })
  })

  describe("a step's own requirement", () => {
    it("values a recovery by a valuation of its own asset", async () => {
      const rule = raiseOff(G, "A recovery is valued by a valuation of its own asset")
      const foreign = await newValuation(database(), fx, at.non.LISTED!.loan.assetId)
      await refuses(rule, /valuation of its own asset/, (tx) => tx.recovery.update({ where: { id: at.non.RECOVERED!.id }, data: { status: "VALUED", valuationId: foreign } }))
      await refuses(rule, /valuation of its own asset/, (tx) => tx.recovery.update({ where: { id: at.non.RECOVERED!.id }, data: { status: "VALUED" } }))
      const own = await newValuation(database(), fx, at.non.RECOVERED!.loan.assetId)
      await admits((tx) => tx.recovery.update({ where: { id: at.non.RECOVERED!.id }, data: { status: "VALUED", valuationId: own } }))
    })

    it("reuses its surrender's valuation (s127)", async () => {
      const other = await newValuation(database(), fx, s127.loan.assetId, 90_000_000)
      await refuses(raiseOff(G, "An s127 recovery reuses its surrender's valuation"), /reuses its surrender's valuation/,
        (tx) => tx.recovery.update({ where: { id: s127.id }, data: { status: "VALUED", valuationId: other } }))
      await admits((tx) => tx.recovery.update({ where: { id: s127.id }, data: { status: "VALUED", valuationId: s127.valuation } }))
    })

    it("issues an s131 valuation notice with its stored bytes, and an s127 one after its surrender's", async () => {
      await refuses(raiseOff(G, "An s131 valuation notice is stored with its digest"), /stored with its digest/, move("nca", "VALUED", "VALUATION_NOTICE_ISSUED"))
      await admits((tx) => tx.recovery.update({
        where: { id: at.nca.VALUED!.id }, data: { status: "VALUATION_NOTICE_ISSUED", valuationNoticePath: "/nonexistent/vn.pdf", valuationNoticeSha256: "b".repeat(64) },
      }))
      const toNotice = async (tx: Tx) => {
        await triggersOff(tx) // the recovery stands at VALUED with the surrender's valuation, set aside for this step
        await tx.recovery.update({ where: { id: s127.id }, data: { status: "VALUED", valuationId: s127.valuation } })
        await triggersOn(tx)
        await tx.recovery.update({ where: { id: s127.id }, data: { status: "VALUATION_NOTICE_ISSUED" } })
      }
      await refuses(raiseOff(G, "An s127 recovery follows its surrender's valuation notice"), /follows its surrender's valuation notice/, toNotice)
      await admits(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "SurrenderRequest" SET "status" = 'VALUATION_NOTICE_ISSUED', "valuationNoticePath" = '/x.pdf', "valuationNoticeSha256" = '${"b".repeat(64)}' WHERE "id" = '${s127.surrenderId}'`)
        await toNotice(tx)
      })
    })

    it("is sold by a completed remarketing sale", async () => {
      const rule = raiseOff(G, "A recovery is sold by a completed remarketing sale")
      await refuses(rule, /sold by a completed remarketing sale/, move("non", "LISTED", "SOLD"))
      await admits((tx) => tx.recovery.update({ where: { id: listedSold.id }, data: { status: "SOLD" } }))
    })

    it("is withdrawn with a reason of at least 10 characters, and not once a sale is complete", async () => {
      const withdraw = (id: string, withdrawnReason: string) => (tx: Tx) =>
        tx.recovery.update({ where: { id }, data: { status: "WITHDRAWN", withdrawnReason, closedAt: new Date() } })
      await refuses(raiseOff(G, "A withdrawal records its reason (at least 10 characters)"), /records its reason/, withdraw(at.non.LISTED!.id, "too short"))
      await refuses(raiseOff(G, "A recovery with a completed sale cannot be withdrawn"), /completed sale cannot be withdrawn/, withdraw(listedSold.id, "Debtor paid the arrears in full"))
      await admits(withdraw(at.non.LISTED!.id, "Debtor paid the arrears in full"))
    })
  })

  it("keeps the matrix and the asset's status together: a withdrawal frees the asset, a completed sale closes it to a new deal", async () => {
    const status = (id: string) => database().financedAsset.findUniqueOrThrow({ where: { id }, select: { lessorStatus: true } }).then((a) => a.lessorStatus)
    expect(await status(at.non.WITHDRAWN!.loan.assetId)).toBeNull()
    expect(await status(at.non.SOLD!.loan.assetId)).toBe("SOLD_IN_REMARKETING")
    expect(await status(at.non.LISTED!.loan.assetId)).toBe("RECOVERED")
    expect(await status(listedSold.loan.assetId)).toBe("SOLD_IN_REMARKETING")
  })
})
