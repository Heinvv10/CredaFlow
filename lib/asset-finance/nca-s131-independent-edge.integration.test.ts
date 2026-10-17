/** Independent regressions for frozen 6c694e3a. PostgreSQL execution UNRUN pending §8 approval. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupRecoveryFixture, courtMatter, createRecoveryFixture, day, newLoan, newRecovery, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { determineSurplusRecipient } from "./nca-surplus.integration-fixture"
import { approveSurplusAccount, recordSurplusAccount } from "./nca-surplus-account"
import { issueNcaSurplusRemittance } from "./nca-surplus"
import { recordSurplusExecution } from "./nca-surplus-execution"
import { issueRecoveryFinalNotice } from "./recovery-notices"
import { rules, type Tx } from "./recovery-rules.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
const run = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const db = run ? new PrismaClient() : null
const d = () => { if (!db) throw new Error("real PostgreSQL required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const proof = (label: string) => ({ file: new File([`%PDF-1.4 TEST synthetic ${label}`], "test.pdf", { type: "application/pdf" }), docType: "OTHER" as const, dealId: null })

;(run ? describe : describe.skip)("independent s131 first-notice remittance boundary", () => {
  beforeAll(async () => { fx = await createRecoveryFixture(d(), token) }, 180000)
  afterAll(async () => { await cleanupRecoveryFixture(d(), recoveryFixtureTenantId(token)); await d().$disconnect() }, 60000)
  const actor = () => ({ tenantId: fx.tenantId, userId: fx.officer })
  async function attachment() {
    const loan = await newLoan(d(), fx, "NCA")
    const recoveryId = await newRecovery(d(), fx, loan, "NCA_S131_ATTACHMENT", { legalMatterId: await courtMatter(d(), fx, loan) })
    await testSetup(d(),
      [`UPDATE "Loan" SET "status"='COMPLETED' WHERE "id"=$1`, loan.loanId],
      [`UPDATE "Recovery" SET "status"='PROCEEDS_APPLIED',"settlementDueCents"=300000,"grossProceedsCents"=312345,"deductedCostsCents"=0,"chargedCostsCents"=0,"netProceedsCents"=312345,"shortfallCents"=0,"surplusCents"=12345,"unrecoverableCostsCents"=0,"chargesFrozenFrom"=$2::date WHERE "id"=$1`, recoveryId, day(0)])
    await determineSurplusRecipient(fx, loan.loanId)
    return { loanId: loan.loanId, recoveryId, amountCents: 12345 }
  }
  async function bank(loanId: string) {
    expect(await recordSurplusAccount(actor(), loanId, { bank: { accountHolder: "TEST Consumer", bankName: "TEST Bank", branchCode: "000000", accountNumber: "0000000001", accountType: null }, upload: proof("bank account") })).toMatchObject({ kind: "done" })
    expect(await approveSurplusAccount({ ...actor(), userId: fx.adminA }, loanId, "approve")).toMatchObject({ kind: "done" })
  }
  async function authorise(loanId: string) {
    expect(await approveSurplusAccount({ ...actor(), userId: fx.adminB }, loanId, "authorise")).toMatchObject({ kind: "done" })
  }
  async function refusalAndMutation(recoveryId: string) {
    const refused = await issueRecoveryFinalNotice(actor(), recoveryId)
    expect(refused).toMatchObject({ kind: "not_ready" })
    expect(await d().recovery.findUniqueOrThrow({ where: { id: recoveryId } })).toMatchObject({ status: "PROCEEDS_APPLIED", finalNoticePath: null, finalNoticeSha256: null, finalNoticeIssuedOn: null })
    // Isolate the deferred remittance guard; each mutation runs in a rolled-back transaction.
    const attack = async (tx: Tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "Recovery" DISABLE TRIGGER "Recovery_guard"')
      await tx.recovery.update({ where: { id: recoveryId }, data: { status: "FINAL_NOTICE_ISSUED", finalNoticeIssuedOn: new Date(), finalNoticePath: "/synthetic/unpaid.pdf", finalNoticeSha256: "a".repeat(64) } })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    }
    await rules(d).refuses({ table: "Recovery", trigger: "Recovery_final_remittance" }, /verified|execut|remit/i, attack)
  }
  async function payAndIssue(input: Awaited<ReturnType<typeof attachment>>, id: string) {
    const row = await d().ncaSurplusRemittance.findUniqueOrThrow({ where: { id } })
    const execution = { executedOn: day(0), bankReference: `TEST-INDEPENDENT-${randomUUID()}`, amountCents: 12345, destinationAccountId: row.accountId!, destinationConfirmed: true, upload: proof("actual execution") }
    // Wrong money or destination cannot consume the unpaid instruction or create evidence.
    const before = await d().entityDocument.count({ where: { tenantId: fx.tenantId } })
    for (const invalid of [{ ...execution, amountCents: 12344 }, { ...execution, destinationAccountId: randomUUID() }]) {
      expect(await recordSurplusExecution(actor(), input.loanId, id, invalid)).toMatchObject({ kind: "not_ready" })
      expect((await d().ncaSurplusRemittance.findUniqueOrThrow({ where: { id } })).executedOn).toBeNull()
    }
    expect(await d().entityDocument.count({ where: { tenantId: fx.tenantId } })).toBe(before)
    expect(await recordSurplusExecution(actor(), input.loanId, id, execution)).toMatchObject({ kind: "done", id })
    const paid = await d().ncaSurplusRemittance.findUniqueOrThrow({ where: { id } })
    expect(paid.executionEvidenceDocumentId).toBeTruthy()
    expect(await recordSurplusExecution(actor(), input.loanId, id, execution)).toMatchObject({ kind: "not_ready" })
    expect(await d().ncaSurplusRemittance.findUniqueOrThrow({ where: { id } })).toEqual(paid)
    expect(await issueRecoveryFinalNotice(actor(), input.recoveryId)).toMatchObject({ kind: "done" })
    const final = await d().recovery.findUniqueOrThrow({ where: { id: input.recoveryId } })
    expect(final.status).toBe("FINAL_NOTICE_ISSUED")
    expect(final.finalNoticePath).toBeTruthy()
    expect(final.finalNoticeSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await issueRecoveryFinalNotice(actor(), input.recoveryId)).toMatchObject({ kind: "not_ready" })
    expect(await d().recovery.findUniqueOrThrow({ where: { id: input.recoveryId } })).toEqual(final)
    expect(await d().ncaSurplusRemittance.count({ where: { recoveryId: input.recoveryId } })).toBe(1)
    expect(await d().payment.count({ where: { loanId: input.loanId } })).toBe(0)
  }
  it("refuses an ordinary unpaid attachment final notice; exact payment permits the first notice once", async () => {
    const input = await attachment()
    await bank(input.loanId)
    await authorise(input.loanId)
    const row = await d().$transaction(tx => issueNcaSurplusRemittance(tx as never, actor(), input))
    expect(row).toMatchObject({ status: "INSTRUCTED", executedOn: null })
    await refusalAndMutation(input.recoveryId)
    await payAndIssue(input, row!.id)
  })
  it("cannot reuse a prepared held exception after account verification before the first notice", async () => {
    const input = await attachment()
    const held = await d().$transaction(tx => issueNcaSurplusRemittance(tx as never, actor(), input))
    expect(held).toMatchObject({ status: "HELD_NO_VERIFIED_ACCOUNT", accountId: null })
    await bank(input.loanId)
    await refusalAndMutation(input.recoveryId)
    await authorise(input.loanId)
    expect(await d().ncaSurplusRemittance.findUniqueOrThrow({ where: { id: held!.id } })).toMatchObject({ status: "INSTRUCTED", exceptionReason: held!.exceptionReason, executedOn: null })
    await refusalAndMutation(input.recoveryId)
    await payAndIssue(input, held!.id)
  })
})
