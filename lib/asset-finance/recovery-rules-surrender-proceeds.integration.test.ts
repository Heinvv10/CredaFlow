/**
 * Slice 4a a surrender a recovery links is credited by that recovery's proceeds
 * and nothing else (migration 20261015400000, a rule of its own beside
 * guardSurrenderRequest): the standalone credit path checks for a recovery and
 * then writes, so a recovery linked in between would credit the surrender
 * twice. The attack is refused, and goes through with that one statement taken
 * out, inside a rolled-back transaction; a surrender with no recovery, and the
 * recovery's own proceeds, are credited as before.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-surrender-proceeds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { testSetup } from "./lease-servicing.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newLoan, newSurrender, newValuation, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { raiseOff, rules, type Tx } from "./recovery-rules.integration-fixture"

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
const MESSAGE = "Sale proceeds for this surrender go through its recovery"
/** linked: a recovery LISTED on its surrender; proceeded: one with its proceeds applied (its receipt on the recovery); free: a surrender no recovery links. */
const S = {} as Record<"linked" | "proceeded" | "free", { surrenderId: string; loanId: string; assetId: string; recoveryId?: string }>

const credit = (surrender: { surrenderId: string; loanId: string }, payment: string, amount: number, shortfall = 0, refund = 0) => (tx: Tx) =>
  tx.surrenderRequest.update({
    where: { id: surrender.surrenderId },
    data: { status: "PROCEEDS_CREDITED", saleProceedsCents: amount, proceedsPaymentId: payment, shortfallCents: shortfall, refundCents: refund },
  })
const receipt = (loanId: string, amount: number) => (tx: Tx) => tx.payment.create({ data: { tenantId: fx.tenantId, loanId, amount, capturedBy: fx.officer } })

suite("slice 4a a surrender with a recovery is credited by the recovery", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    const linked = await ladderRecovery(database(), fx, true, "LISTED", {}, true)
    S.linked = { surrenderId: linked.surrenderId as string, loanId: linked.loan.loanId, assetId: linked.loan.assetId, recoveryId: linked.id }
    const proceeded = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED", {}, true)
    S.proceeded = { surrenderId: proceeded.surrenderId as string, loanId: proceeded.loan.loanId, assetId: proceeded.loan.assetId, recoveryId: proceeded.id }
    const loan = await newLoan(database(), fx, "NCA")
    const surrenderId = await newSurrender(database(), fx, loan)
    const valuationId = await newValuation(database(), fx, loan.assetId)
    await testSetup(database(), [`UPDATE "SurrenderRequest" SET "status" = 'VALUATION_NOTICE_ISSUED', "valuationId" = $1, "valuationNoticePath" = '/nonexistent/vn.pdf', "valuationNoticeSha256" = $2, "valuationNoticeIssuedOn"=CURRENT_DATE-30, "valuationNoticeReceivedOn"=CURRENT_DATE-30, "valuationReceiptReference"='Synthetic received notice; clock advanced' WHERE "id" = $3`, valuationId, "b".repeat(64), surrenderId])
    S.free = { surrenderId, loanId: loan.loanId, assetId: loan.assetId }
  }, 600_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("refuses to credit it with a receipt of its own while a recovery links it", async () => {
    const attack = async (tx: Tx) => {
      const payment = await receipt(S.linked.loanId, 50_000_000)(tx)
      await credit(S.linked, payment.id, 50_000_000)(tx)
    }
    await refuses(raiseOff("guardSurrenderRecoveryProceeds", MESSAGE), new RegExp(MESSAGE), attack)
    await refuses({ table: "SurrenderRequest", trigger: "SurrenderRequest_recovery_proceeds" }, new RegExp(MESSAGE), attack)
  })

  it("refuses a receipt that is not the recovery's own, even once the recovery has its proceeds", async () => {
    await refuses(raiseOff("guardSurrenderRecoveryProceeds", MESSAGE), new RegExp(MESSAGE), async (tx) => {
      const recovery = await tx.recovery.findUniqueOrThrow({ where: { id: S.proceeded.recoveryId }, select: { proceedsPaymentId: true, netProceedsCents: true } })
      const other = await receipt(S.proceeded.loanId, recovery.netProceedsCents as number)(tx)
      await credit(S.proceeded, other.id, other.amount)(tx)
    })
  })

  it("credits it with the recovery's own proceeds receipt", async () => {
    await admits(async (tx) => {
      const recovery = await tx.recovery.findUniqueOrThrow({ where: { id: S.proceeded.recoveryId }, select: { proceedsPaymentId: true, shortfallCents: true, surplusCents: true } })
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: recovery.proceedsPaymentId as string } })
      await credit(S.proceeded, payment.id, payment.amount, recovery.shortfallCents ?? 0, recovery.surplusCents ?? 0)(tx)
    })
  })

  it("credits a surrender no recovery links, as before", async () => {
    await admits(async (tx) => {
      const payment = await receipt(S.free.loanId, 50_000_000)(tx)
      await credit(S.free, payment.id, 50_000_000)(tx)
    })
  })
})
