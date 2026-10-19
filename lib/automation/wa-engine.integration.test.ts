/**
 * Real-PostgreSQL proof of the automated WhatsApp reminders' guard rails:
 * the per-lender switch, one reminder per arrears episode, the paid-in-full
 * window and the collections holds. Provider dispatch is mocked: no network.
 *
 *   RUN_AUTOMATION_WA_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/automation/wa-engine.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { dispatch } from "@/lib/messaging/providers"
import { runAutomationEngine } from "./engine"

vi.mock("@/lib/messaging/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/providers")>()),
  dispatch: vi.fn(),
}))

const RUN = process.env.RUN_AUTOMATION_WA_IT === "1"
const suite = RUN ? describe : describe.skip
const DAY = 24 * 60 * 60 * 1000
let errorSpy: ReturnType<typeof vi.spyOn>

type Fixture = { tenantId: string; productId: string; n: number }

async function newTenant(automatedWhatsAppReminders: boolean): Promise<Fixture> {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_wa_engine_${token}`
  const productId = `product_wa_engine_${token}`
  await withoutTenantScope(async () => {
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `wa-engine-${token}`,
        name: "WA engine",
        config: { create: { ...VALID_LENDER_COLUMNS, automatedWhatsAppReminders } },
      },
    })
    await prisma.loanProduct.create({
      data: {
        id: productId, tenantId, code: `WE-${token.slice(0, 10)}`, name: "WA engine product", productType: "PERSONAL",
        minAmount: 10_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
      },
    })
  })
  return { tenantId, productId, n: 0 }
}

async function borrower(
  f: Fixture,
  loan: { status: "ACTIVE" | "COMPLETED"; daysInArrears?: number; closedAt?: Date; collectionsStage?: "PAYMENT_ARRANGEMENT" },
  extra: { debtReview?: boolean } = {},
) {
  const id = `${f.tenantId}_${++f.n}`
  const { tenantId, productId } = f
  const arrears = loan.status === "ACTIVE"
  await withoutTenantScope(async () => {
    await prisma.client.create({
      data: {
        id: `client_${id}`, tenantId, reference: `CLI-${id}`.slice(-30), idNumber: id.slice(-13),
        firstName: "Synthetic", lastName: "Borrower", email: `${id}@test.invalid`, phone: "+27820000003",
      },
    })
    await prisma.contact.create({
      data: {
        id: `contact_${id}`, tenantId, clientId: `client_${id}`, status: "CLIENT", firstSeenChannel: "WHATSAPP",
        primaryWaJid: "27820000003@s.whatsapp.net",
      },
    })
    if (extra.debtReview) {
      await prisma.creditBureauCheck.create({
        data: { tenantId, clientId: `client_${id}`, ok: true, underDebtReview: true },
      })
    }
    await prisma.loanApplication.create({
      data: {
        id: `app_${id}`, tenantId, reference: `APP-${id}`.slice(-30), clientId: `client_${id}`, productId,
        appliedAmount: 100_000, appliedTermDays: 30,
      },
    })
    await prisma.loan.create({
      data: {
        id: `loan_${id}`, tenantId, reference: `LN-${id}`.slice(-30), applicationId: `app_${id}`,
        clientId: `client_${id}`, productId, principal: 100_000, totalInterest: 5_000, initiationFee: 0,
        totalRepayable: 105_000, outstandingPrincipal: arrears ? 100_000 : 0, status: loan.status,
        startDate: new Date("2026-07-01T00:00:00.000Z"), maturityDate: new Date("2026-07-31T00:00:00.000Z"),
        interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL", monthlyServiceFee: 0,
        daysInArrears: loan.daysInArrears ?? 0, arrearsAmount: arrears ? 10_000 : 0,
        ...(loan.closedAt ? { closedAt: loan.closedAt } : {}),
        ...(loan.collectionsStage ? { collectionsStage: loan.collectionsStage } : {}),
      },
    })
  })
  return `loan_${id}`
}

const run = (tenantId: string) => withoutTenantScope(() => runAutomationEngine(tenantId))
const messages = (tenantId: string) => withoutTenantScope(() => prisma.message.count({ where: { tenantId } }))
const setDpd = (loanId: string, daysInArrears: number) =>
  withoutTenantScope(async () => { await prisma.loan.update({ where: { id: loanId }, data: { daysInArrears } }) })

suite("automated WhatsApp guard rails (real Postgres)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(dispatch).mockImplementation(async () => ({ providerMessageId: `p_${randomUUID()}`, acceptedAt: new Date() }))
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => errorSpy.mockRestore())

  it("setting off (the default): nothing is reserved or dispatched", async () => {
    const f = await newTenant(false)
    await borrower(f, { status: "ACTIVE", daysInArrears: 7 })
    await borrower(f, { status: "COMPLETED", closedAt: new Date() })
    await run(f.tenantId)
    expect(await messages(f.tenantId)).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await withoutTenantScope(() => prisma.automationLog.count({ where: { tenantId: f.tenantId, result: { not: "success" } } }))).toBe(0)
  })

  it("DPD reminders fire once per rule per episode, however many runs and days pass", async () => {
    const f = await newTenant(true)
    const day1 = await borrower(f, { status: "ACTIVE", daysInArrears: 1 })
    const day7 = await borrower(f, { status: "ACTIVE", daysInArrears: 7 })
    const day40 = await borrower(f, { status: "ACTIVE", daysInArrears: 40 })
    await run(f.tenantId)
    await run(f.tenantId)
    expect(await messages(f.tenantId)).toBe(2)
    // The next day the same loans are one day further on: nothing new, and
    // the DPD 40 loan was never told it is 7 days overdue.
    await setDpd(day1, 2)
    await setDpd(day7, 8)
    await run(f.tenantId)
    expect(await messages(f.tenantId)).toBe(2)
    const toDpd40 = await withoutTenantScope(() => prisma.automationLog.count({ where: { tenantId: f.tenantId, entityId: day40 } }))
    expect(toDpd40).toBe(0)
  })

  it("a loan completed long ago is not messaged; one completed just now is", async () => {
    const f = await newTenant(true)
    await borrower(f, { status: "COMPLETED", closedAt: new Date(Date.now() - 30 * DAY) })
    await run(f.tenantId)
    expect(await messages(f.tenantId)).toBe(0)
    await borrower(f, { status: "COMPLETED", closedAt: new Date(Date.now() - 1 * DAY) })
    await run(f.tenantId)
    expect(await messages(f.tenantId)).toBe(1)
  })

  it("debt-review and payment-arrangement loans are skipped, with the reason logged", async () => {
    const f = await newTenant(true)
    const review = await borrower(f, { status: "ACTIVE", daysInArrears: 7 }, { debtReview: true })
    const arranged = await borrower(f, { status: "ACTIVE", daysInArrears: 7, collectionsStage: "PAYMENT_ARRANGEMENT" })
    await run(f.tenantId)
    expect(await messages(f.tenantId)).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    const logs = await withoutTenantScope(() => prisma.automationLog.findMany({
      where: { tenantId: f.tenantId, result: "skipped", entityId: { in: [review, arranged] } },
      select: { entityId: true, error: true },
    }))
    expect(logs).toEqual(expect.arrayContaining([
      { entityId: review, error: "client is under debt review" },
      { entityId: arranged, error: "collections stage PAYMENT_ARRANGEMENT" },
    ]))
  })
})
