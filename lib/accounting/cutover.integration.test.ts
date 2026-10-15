/**
 * Real-Postgres proof of the go-live cutover and payout-driven bank postings:
 * history before the go-live month closes as one opening entry plus stored
 * per-source positions; a disbursement paid through the payout channel hits
 * the bank only when its payout is paid; every close ties to what borrowers owe.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/cutover.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createDisbursementPayout } from "@/lib/payouts/disbursement"
import { closePeriod } from "./generate"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-11-05T10:00:00+02:00")

async function lender(goLiveMonth: string) {
  const ids = await createChargesLoan(db, await createChargesTenant(db, false))
  await db.accountingSettings.create({ data: { tenantId: ids.tenantId, goLiveMonth, mappingConfirmedAt: new Date() } })
  return ids
}
const close = (tenantId: string, userId: string, periodKey: string) => runWithTenant(tenantId, () =>
  closePeriod(prisma, { tenantId, periodKey, userId, userEmail: "cutover-it@test.invalid", now: AFTER }))
const linesOf = (batchId: string) => db.accountingLedgerEntry.findMany({ where: { batchId }, include: { lines: true }, orderBy: { eventKey: "asc" } })

suite.sequential("go-live cutover and payout-driven bank postings (real Postgres)", () => {
  afterAll(async () => { await db.$disconnect() })

  it("posts history before go-live as one opening entry, then only what happens after", async () => {
    // The fixture loan starts 1 Aug (R2,000) with one instalment due 1 Sep.
    const ids = await lender("2026-09")
    const sep = await close(ids.tenantId, ids.userId, "2026-09")
    const entries = await linesOf(sep.batchId)
    const opening = entries.find((e) => e.eventType === "OPENING")!
    expect(opening).toMatchObject({ eventKey: "opening:2026-09", postingDate: "2026-09-01" })
    expect(opening.lines.map((l) => [l.role, l.debitCents, l.creditCents]).sort()).toEqual([
      ["LOAN_BOOK", 200_000, 0], ["OPENING_BALANCE_EQUITY", 0, 200_000],
    ])
    expect(entries.filter((e) => e.eventType === "DISBURSEMENT")).toHaveLength(0)
    expect(entries.filter((e) => e.eventType === "INSTALMENT_DUE")).toHaveLength(1)
    expect(await db.accountingOpeningPosition.count({ where: { batchId: sep.batchId } })).toBe(2)
    // October: nothing re-posts the history.
    const oct = await close(ids.tenantId, ids.userId, "2026-10")
    expect((await linesOf(oct.batchId)).filter((e) => e.eventType === "DISBURSEMENT" || e.eventType === "OPENING")).toHaveLength(0)
  })

  it("credits payout clearing at booking and the bank only once the payout is paid", async () => {
    const ids = await lender("2026-08")
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true } })
    const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
      tenantId: ids.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "simulated",
      amountCents: 200_000, reference: loan.reference,
      beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001234", accountType: "SAVINGS" },
      user: { id: ids.userId, email: "d@test.invalid" }, avs: { avsCheckId: "it", simulated: true },
    }))
    const aug = await close(ids.tenantId, ids.userId, "2026-08")
    const augRoles = (await linesOf(aug.batchId)).flatMap((e) => e.lines.map((l) => l.role))
    expect(augRoles).toContain("PAYOUT_CLEARING")
    expect(augRoles).not.toContain("BANK")
    await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date("2026-09-02T08:00:00Z") } })
    await db.disbursementPayout.update({ where: { id }, data: { status: "PAID", paidAt: new Date("2026-09-03T08:00:00Z") } })
    const sep = await close(ids.tenantId, ids.userId, "2026-09")
    const paid = (await linesOf(sep.batchId)).find((e) => e.eventType === "PAYOUT_PAID")!
    expect(paid.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([["PAYOUT_CLEARING", 200_000, 0], ["BANK", 0, 200_000]])
  })
})
