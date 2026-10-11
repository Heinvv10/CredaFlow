/**
 * Further regressions for default charges. There are no off-window cases: the kill
 * switch is one-way (charges-stop.integration.test.ts).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-round4-regressions.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, NOW, SCHEDULE_TOTAL } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "brk@test.invalid", role: "SUPER_ADMIN" } })) }))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  getDefaultTenantId: async () => ctx.tenantId,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma as payments } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { applyChargesBackfill } from "./charges-backfill"
import { applyBankTransaction } from "@/lib/bank-sync/apply"
import { PATCH as reconcile } from "@/app/api/payments/[id]/reconcile/route"
import { finaliseSection129Issuance, type Section129RecordData } from "@/lib/collections/section129-artifact"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
async function createLoan() {
  const ids = await createChargesLoan(db, await createChargesTenant(db, true))
  ctx.tenantId = ids.tenantId; ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const capture = (ids: Ids, amount: number, over: Record<string, unknown> = {}) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId, ...over }))
const paysOf = (ids: Ids) => db.payment.findMany({ where: { loanId: ids.loanId }, orderBy: { createdAt: "asc" } })
const req = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "PATCH", body: JSON.stringify(body) })
const actorOf = (ids: Ids) => ({ userId: ids.userId, userEmail: "brk@test.invalid" })

async function reserveNotice(ids: Ids, at: Date) {
  const recordData = {
    lifecycle: "DISPATCHING", loanReference: "LN", clientName: "C T", clientEmail: "c@test.invalid",
    clientFirstName: "C", clientLastName: "T", clientIdNumber: "9001015800080", clientAddressLine1: null, clientCity: null,
    arrearsAmount: SCHEDULE_TOTAL, outstandingPrincipal: 200_000, daysInArrears: 25, noticeDate: "2026-09-26",
    fileName: "s129.pdf", pdfSha256: "a".repeat(64), reservedById: ids.userId, reservedAt: at.toISOString(), dispatchStartedAt: at.toISOString(),
  } satisfies Section129RecordData
  const record = await db.complianceRecord.create({ data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129-${ids.loanId}`, status: "PENDING", data: recordData } })
  return { record, recordData }
}

suite.sequential("charges value-date ordering and held bank-line regressions (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("a value date later today is refused, and a notice is dated after every receipt already on the loan", async () => {
    const ids = await createLoan()
    const { record, recordData } = await reserveNotice(ids, new Date("2026-09-26T09:00:00+02:00"))
    // 10:00: staff try to capture a deposit the bank shows at 16:00 today.
    await expect(capture(ids, 50_000, { receivedAt: new Date("2026-09-26T16:00:00+02:00") })).rejects.toThrow(/future/)
    // 01:00: a capture dated just "today" (02:00 SAST) is accepted...
    vi.setSystemTime(new Date("2026-09-26T01:00:00+02:00"))
    await capture(ids, 50_000, { receivedAt: new Date("2026-09-26T00:00:00.000Z") })
    const split = (await paysOf(ids))[0].defaultInterestAllocated
    // ...and a notice finalised at 01:30 is charged at 02:00, after it, so it
    // never re-splits that receipt, and the issuance is recorded.
    vi.setSystemTime(new Date("2026-09-26T01:30:00+02:00"))
    await runWithTenant(ids.tenantId, () => finaliseSection129Issuance({
      reservation: { issuanceId: record.id, idempotencyKey: `s129-${ids.loanId}`, pdfSha256: "a".repeat(64), recordData },
      tenantId: ids.tenantId, loanId: ids.loanId, issuedById: ids.userId, emailMessageId: "m-1", issuedAt: new Date("2026-09-26T01:15:00+02:00"),
    }))
    const rec = await db.complianceRecord.findUniqueOrThrow({ where: { id: record.id } })
    expect(rec.status).toBe("COMPLETED")
    expect(rec.data).toMatchObject({ lifecycle: "ISSUED", adminChargeAt: new Date("2026-09-26T00:00:00.000Z").toISOString() })
    expect((await paysOf(ids))[0].defaultInterestAllocated).toBe(split)
  })

  it("a bank line held (charges refused) can be allocated once the cause is fixed, and is never double-booked", async () => {
    const ids = await createLoan()
    // An issued notice without a frozen amount (e.g. finalised by the previous image) -> every replay refuses.
    await db.complianceRecord.create({ data: { tenantId: ids.tenantId, type: "SECTION_129_NOTICE", referenceId: ids.loanId, idempotencyKey: `s129u-${ids.loanId}`, status: "COMPLETED", completedAt: new Date("2026-09-10T10:00:00+02:00"), data: { lifecycle: "ISSUED" } } })
    const imp = await db.bankStatementImport.create({ data: { tenantId: ids.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" } })
    const txn = await db.bankTransaction.create({ data: { tenantId: ids.tenantId, importId: imp.id, postedDate: NOW, valueDate: NOW, amountCents: 30_000, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED" } })
    const first = await applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userEmail: "x@test.invalid" })
    await expect(applyBankTransaction({ txnId: txn.id, loanId: ids.loanId, tenantId: ids.tenantId, userEmail: "x@test.invalid" }))
      .rejects.toThrow(/Only unreconciled transactions/)
    // --apply stamps the notice (the documented remedy), then staff allocate the held receipt.
    await runWithTenant(ids.tenantId, () => applyChargesBackfill(payments, ids.tenantId, NOW, actorOf(ids)))
    const res = await reconcile(req({ action: "allocate", reason: "Held by charges refusal, cause fixed", reference: "BANK-1" }), { params: Promise.resolve({ id: first.paymentId }) })
    const pays = await paysOf(ids)
    expect(res.status).toBe(200)
    expect(pays.reduce((s, p) => s + (p.reversed ? 0 : p.amount), 0)).toBe(30_000)
  })
})
