/**
 * Slice 4a evidence documents (migration 20261015400000): a document that
 * evidences a legal matter step, or a surplus refund's bank verification, is
 * never soft-deleted (the document route's delete sets deletedAt). The attack
 * is refused, and goes through with that one statement or the trigger taken
 * out, inside a rolled-back transaction; any other document is deleted as
 * before.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-evidence.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { addStep, cleanupRecoveryFixture, createRecoveryFixture, legalDocument, newLoan, newMatter, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
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
const docs = { step: "", bank: "", free: "" }
const MESSAGE = /evidences a legal matter step or a refund's bank verification cannot be deleted/
const softDelete = (id: string) => (tx: Tx) => tx.entityDocument.update({ where: { id }, data: { deletedAt: new Date(), deletedById: fx.officer } })

suite("slice 4a evidence documents are not deleted", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    docs.step = await legalDocument(database(), fx)
    await addStep(database(), fx, await newMatter(database(), fx, (await newLoan(database(), fx, "NCA")).loanId), "JUDGMENT", undefined, { evidenceDocumentId: docs.step })
    docs.bank = await legalDocument(database(), fx, "OTHER")
    const surplus = await ladderRecovery(database(), fx, false, "SURPLUS_HELD", { settlementCents: 80_000_000 })
    const { surplusCents } = await database().recovery.findUniqueOrThrow({ where: { id: surplus.id }, select: { surplusCents: true } })
    await database().recoveryRefund.create({
      data: {
        tenantId: fx.tenantId, recoveryId: surplus.id, amountCents: surplusCents as number, accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000001",
        bankVerifiedById: fx.adminA, bankVerificationDocumentId: docs.bank, createdById: fx.officer,
      },
    })
    docs.free = await legalDocument(database(), fx, "OTHER")
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("keeps the evidence of a legal matter step", async () => {
    await refuses(raiseOff("guardRecoveryEvidenceDocument", "A document that evidences a legal matter step or a refund's bank verification cannot be deleted"), MESSAGE, softDelete(docs.step))
    await refuses({ table: "EntityDocument", trigger: "EntityDocument_recovery_evidence" }, MESSAGE, softDelete(docs.step))
  })

  it("keeps the bank verification of a surplus refund", async () => {
    await refuses(raiseOff("guardRecoveryEvidenceDocument", "A document that evidences a legal matter step or a refund's bank verification cannot be deleted"), MESSAGE, softDelete(docs.bank))
  })

  it("still deletes a document nothing stands on", async () => {
    await admits(softDelete(docs.free))
  })
})
