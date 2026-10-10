/**
 * Further regressions for default charges, run against real Postgres.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/charges-round5-regressions.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant, DEFAULT_INTEREST, NOW, SCHEDULE_TOTAL } from "./charges.integration-fixture"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "r5@test.invalid", role: "SUPER_ADMIN" } })),
  requireOwnerOrStaff: vi.fn(async () => ({ error: null, type: "staff", user: { id: ctx.userId, role: "SUPER_ADMIN" } })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  getDefaultTenantId: async () => ctx.tenantId,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma as payments } from "@/lib/prisma"
import { applyManualReceipt } from "./apply-payment"
import { disableCharges } from "./charges-backfill"
import { loanSettlementFigures } from "./charges-summary"
import { GET as statement } from "@/app/api/loans/[id]/statement/route"
import { GET as certificate } from "@/app/api/loans/[id]/certificate-of-balance/route"
import { staffLoanFigures } from "./loan-page-figures"
import { POST as bulkUpload } from "@/app/api/payments/bulk-upload/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
async function createLoan(enabled = true) {
  const ids = await createChargesLoan(db, await createChargesTenant(db, enabled))
  ctx.tenantId = ids.tenantId
  ctx.userId = ids.userId
  return ids
}
type Ids = Awaited<ReturnType<typeof createLoan>>
const capture = (ids: Ids, amount: number) =>
  runWithTenant(ids.tenantId, () => applyManualReceipt(payments, { loanId: ids.loanId, tenantId: ids.tenantId, amount, capturedById: ids.userId }))

/** A rendered document's text lines. */
async function pdfLines(res: Response): Promise<string[]> {
  // A refusal (e.g. 409 LENDER_IDENTITY_NOT_CONFIGURED) must fail as itself,
  // not as pdftotext choking on a JSON body.
  if (res.status !== 200 || res.headers.get("content-type") !== "application/pdf") {
    throw new Error(`expected a PDF, got ${res.status} ${res.headers.get("content-type")}: ${await res.text()}`)
  }
  const path = join(mkdtempSync(join(tmpdir(), "r5-")), "doc.pdf")
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  try {
    return execFileSync("pdftotext", ["-layout", path, "-"]).toString().split("\n")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("pdftotext is not installed (poppler-utils); this suite reads the rendered PDFs with it")
    throw error
  }
}
const cents = (text: string) => Math.round(Number(text.replaceAll(",", "")) * 100)
const docParams = (ids: Ids) => ({ params: Promise.resolve({ id: ids.loanId }) })
/** "Total Paid to Date" on the statement and on the certificate of balance. */
async function paidToDate(ids: Ids) {
  const read = (lines: string[]) => cents(lines.find((line) => line.includes("Total Paid to Date"))!.match(/R ([\d,]+\.\d{2})/)![1])
  return {
    statement: read(await pdfLines(await statement(new NextRequest("http://localhost/s"), docParams(ids)))),
    certificate: read(await pdfLines(await certificate(new NextRequest("http://localhost/c"), docParams(ids)))),
  }
}

/** The statement's final running balance, read off the rendered PDF. */
async function statementBalance(ids: Ids): Promise<number> {
  const res = await statement(new NextRequest(`http://localhost/api/loans/${ids.loanId}/statement`), { params: Promise.resolve({ id: ids.loanId }) })
  const lines = await pdfLines(res)
  const totals = lines.findIndex((line) => /^\s*TOTAL( PAID)?\s/.test(line))
  for (let i = totals - 1; i >= 0; i--) {
    const match = lines[i].match(/R ([\d,]+\.\d{2})\s*$/)
    if (match) return Math.round(Number(match[1].replaceAll(",", "")) * 100)
  }
  throw new Error("no running balance on the statement")
}
const settlement = async (ids: Ids) => {
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
  return (await runWithTenant(ids.tenantId, () => loanSettlementFigures(payments, loan, new Date()))).totalToSettle
}

suite.sequential("charges statement balance, bulk refund-due and post-stop document regressions (real Postgres)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }) })
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })
  beforeEach(() => { vi.setSystemTime(NOW) })

  it("the statement's final running balance is what the receipt paths accept to settle — never live, live and stopped", async () => {
    const never = await createLoan(false)
    await capture(never, 50_000)
    expect(await statementBalance(never)).toBe(await settlement(never))
    expect(await settlement(never)).toBe(SCHEDULE_TOTAL - 50_000)

    const live = await createLoan()
    await capture(live, 50_000) // R80 of it pays default interest
    expect(await statementBalance(live)).toBe(await settlement(live))

    const stopped = await createLoan()
    await capture(stopped, 50_000)
    await runWithTenant(stopped.tenantId, () => disableCharges(payments, stopped.tenantId, new Date(), { userId: stopped.userId, userEmail: "r5@test.invalid" }))
    // Stopped: the R80 stays paid as charges; the schedule share is R420.
    expect(await settlement(stopped)).toBe(SCHEDULE_TOTAL - (50_000 - DEFAULT_INTEREST))
    expect(await statementBalance(stopped)).toBe(await settlement(stopped))
  })

  it("a bulk row on a loan already settled before the upload is recorded refund-due, not skipped", async () => {
    const ids = await createLoan()
    await capture(ids, SCHEDULE_TOTAL + DEFAULT_INTEREST)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId } })
    expect(loan.status).toBe("COMPLETED")
    const res = await bulkUpload(new NextRequest("http://localhost/api/test", {
      method: "POST", body: JSON.stringify({ rows: [{ reference: loan.reference, amount: 123 }] }),
    }))
    expect(await res.json()).toMatchObject({ processed: 0, skipped: 0, refundDue: [expect.objectContaining({ row: 1, amount: 12_300 })] })
    const held = await db.payment.findMany({ where: { loanId: ids.loanId, allocationStatus: "UNAPPLIED" } })
    expect(held.map((p) => [p.amount, p.reconciliationReason])).toEqual([[12_300, "overpayment_refund_due"]])
  })

  it("after a stop every document and reader still states the cash the client paid", async () => {
    const ids = await createLoan()
    await capture(ids, 100_000) // pays Sep 2..25 default interest (R80) first
    const cash = { statement: 100_000, certificate: 100_000 }
    expect(await paidToDate(ids)).toEqual(cash)
    await runWithTenant(ids.tenantId, () => disableCharges(payments, ids.tenantId, new Date(), { userId: ids.userId, userEmail: "r5@test.invalid" }))
    expect(await paidToDate(ids)).toEqual(cash)
    // Staff loan page: cash paid, and a balance that is what settles the loan.
    const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, include: { repaymentSchedule: true } })
    const staff = await runWithTenant(ids.tenantId, () => staffLoanFigures(payments, { ...loan, tenantId: ids.tenantId }, new Date()))
    expect(staff).toMatchObject({ cashPaid: 100_000, balance: await settlement(ids), charges: null })
  })
})
