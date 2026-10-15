/**
 * Slice 4a surplus refund rules (migration 20261015400000), each proved as in
 * the lease suites: the attack is refused, and goes through with that one
 * statement, clause, CHECK or index taken out, inside a rolled-back
 * transaction. A refund is the whole surplus, created by one person, approved
 * by a second and released by a third, on the approval it was given, out of a
 * settled loan and an unreversed proceeds receipt; the receipt of a recovery's
 * sale proceeds is never reversed; releasing it closes the recovery.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-refund.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, legalDocument, recoveryFixtureTenantId, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
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
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string; proceedsPaymentId?: string | null }
const R = {} as Record<"surplus" | "listed", Rec>
let bankDocument = ""

const refund = (tx: Pick<PrismaClient, "recoveryRefund">, over: Record<string, unknown> = {}) => tx.recoveryRefund.create({
  data: {
    tenantId: fx.tenantId, recoveryId: R.surplus.id, amountCents: 40_000_000, accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000001",
    bankVerifiedById: fx.adminA, bankVerificationDocumentId: bankDocument, createdById: fx.officer, ...over,
  } as never,
})
const G = "guardRecoveryRefund"
const close = (tx: Tx) => tx.recovery.update({ where: { id: R.surplus.id }, data: { status: "CLOSED", closedAt: new Date() } })

suite("slice 4a surplus refund database rules", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    R.surplus = await ladderRecovery(database(), fx, true, "SURPLUS_HELD", { settlementCents: 80_000_000 })
    R.surplus.proceedsPaymentId = (await database().recovery.findUniqueOrThrow({ where: { id: R.surplus.id } })).proceedsPaymentId
    R.listed = await ladderRecovery(database(), fx, false, "LISTED")
    bankDocument = await legalDocument(database(), fx, "OTHER")
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("surplus refund", () => {
    it("is the whole surplus of a recovery that holds one", async () => {
      const rule = raiseOff(G, "A refund is the whole surplus of a recovery that holds one")
      await refuses(rule, /whole surplus of a recovery that holds one/, (tx) => refund(tx, { amountCents: 39_999_999 }))
      await refuses(rule, /whole surplus of a recovery that holds one/, (tx) => refund(tx, { recoveryId: R.listed.id }),
        [raiseOff(G, "A refund is paid out of a settled loan and an unreversed proceeds receipt")])
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
      await refuses(rule, message, async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "RELEASED", approvedById: fx.adminB, releasedById: fx.adminA, releasedAt: new Date() } }))
      await refuses(rule, message, async (tx) => tx.recoveryRefund.update({ where: { id: await approved(tx) }, data: { status: "PENDING_APPROVAL", approvedById: null } }),
        [raiseOff(G, "A refund is released on the approval it was given")])
      await refuses(raiseOff(G, "A recovery refund is never deleted", PASS_DELETE), /refund is never deleted/, async (tx) => tx.recoveryRefund.delete({ where: { id: await approved(tx) } }))
    })

    it("is approved by someone other than its creator, and releases only once approved (CHECKs)", async () => {
      const approveBy = (approver: string) => async (tx: Tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED", approvedById: approver } })
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_approver_differs" }, /RecoveryRefund_approver_differs/, approveBy(fx.officer))
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_status_columns" }, /RecoveryRefund_status_columns/,
        async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED" } }))
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_status_columns" }, /RecoveryRefund_status_columns/,
        async (tx) => tx.recoveryRefund.update({ where: { id: (await refund(tx)).id }, data: { status: "APPROVED", approvedById: fx.adminB, releasedById: fx.adminA } }))
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_shape" }, /RecoveryRefund_shape/, (tx) => refund(tx, { accountHolder: " " }))
      await admits(approveBy(fx.adminB))
    })

    it("is released by a third person on the approval it was given", async () => {
      const approved = async (tx: Tx) => {
        const r = await refund(tx)
        await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } })
        return r.id
      }
      const release = (id: string, by: string, over: Record<string, unknown> = {}) => (tx: Tx) =>
        tx.recoveryRefund.update({ where: { id }, data: { status: "RELEASED", releasedById: by, releasedAt: new Date(), ...over } })
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_releaser_differs" }, /RecoveryRefund_releaser_differs/, async (tx) => release(await approved(tx), fx.adminB)(tx))
      await refuses(raiseOff(G, "A refund is released on the approval it was given"), /released on the approval it was given/, async (tx) => release(await approved(tx), fx.adminB, { approvedById: fx.adminA })(tx))
      await admits(async (tx) => release(await approved(tx), fx.adminA)(tx))
    })

    it("is released by someone other than its creator too: three different people", async () => {
      await refuses({ table: "RecoveryRefund", constraint: "RecoveryRefund_releaser_not_creator" }, /RecoveryRefund_releaser_not_creator/, async (tx) => {
        const r = await refund(tx)
        await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } })
        await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "RELEASED", releasedById: fx.officer, releasedAt: new Date() } })
      })
    })

    describe("is paid out of money that is there: a settled loan and an unreversed proceeds receipt", () => {
      const BACKED = /paid out of a settled loan and an unreversed proceeds receipt/
      const rule = raiseOff(G, "A refund is paid out of a settled loan and an unreversed proceeds receipt")
      const reverseReceipt = async (tx: Tx) => {
        await triggersOff(tx) // the receipt's reversal as the payment route writes it
        await tx.$executeRawUnsafe(`UPDATE "Payment" SET "reversed" = true, "reversedAt" = CURRENT_TIMESTAMP WHERE "id" = '${R.surplus.proceedsPaymentId}'`)
        await triggersOn(tx)
      }
      const reopenLoan = async (tx: Tx) => {
        await triggersOff(tx)
        await tx.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = '${R.surplus.loan.loanId}'`)
        await triggersOn(tx)
      }
      const approvedRefund = async (tx: Tx) => {
        const r = await refund(tx)
        await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } })
        return r.id
      }

      it("when it is created", async () => {
        await refuses(rule, BACKED, async (tx) => { await reverseReceipt(tx); await refund(tx) })
        await refuses(rule, BACKED, async (tx) => { await reopenLoan(tx); await refund(tx) })
      })

      it("when it is approved", async () => {
        await refuses(rule, BACKED, async (tx) => {
          const r = await refund(tx)
          await reverseReceipt(tx)
          await tx.recoveryRefund.update({ where: { id: r.id }, data: { status: "APPROVED", approvedById: fx.adminB } })
        })
      })

      it("when it is released", async () => {
        await refuses(rule, BACKED, async (tx) => {
          const id = await approvedRefund(tx)
          await reverseReceipt(tx)
          await tx.recoveryRefund.update({ where: { id }, data: { status: "RELEASED", releasedById: fx.adminA, releasedAt: new Date() } })
        })
        await refuses(rule, BACKED, async (tx) => {
          const id = await approvedRefund(tx)
          await reopenLoan(tx)
          await tx.recoveryRefund.update({ where: { id }, data: { status: "RELEASED", releasedById: fx.adminA, releasedAt: new Date() } })
        })
      })

      it("each of the two conditions on its own", async () => {
        await refuses(clauseOff("recoveryRefundBacked", `AND l."status" = 'COMPLETED'`), BACKED, async (tx) => { await reopenLoan(tx); await refund(tx) })
        await refuses(clauseOff("recoveryRefundBacked", `AND (r."proceedsPaymentId" IS NULL OR (p."id" IS NOT NULL AND NOT p."reversed"))`), BACKED,
          async (tx) => { await reverseReceipt(tx); await refund(tx) })
      })
    })

    it("keeps the receipt of a recovery's sale proceeds from being reversed", async () => {
      const reverse = (id: string) => (tx: Tx) => tx.$executeRawUnsafe(`UPDATE "Payment" SET "reversed" = true, "reversedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`)
      await refuses(raiseOff("guardRecoveryProceedsPayment", "A recovery's sale-proceeds receipt is not reversed"), /sale-proceeds receipt is not reversed/, reverse(R.surplus.proceedsPaymentId as string))
      await refuses({ table: "Payment", trigger: "Payment_recovery_proceeds_kept" }, /sale-proceeds receipt is not reversed/, reverse(R.surplus.proceedsPaymentId as string))
      // any other receipt on that loan is reversed as before
      await admits(async (tx) => {
        const other = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: R.surplus.loan.loanId, amount: 1000 } })
        await reverse(other.id)(tx)
      })
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
})
