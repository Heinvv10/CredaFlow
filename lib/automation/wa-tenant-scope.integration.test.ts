/**
 * Real-PostgreSQL proof that actionSendWa scopes its Loan / RepaymentSchedule
 * lookup by tenant (not through Client.branch, which no creation path sets).
 * Provider dispatch is mocked: no network call can happen.
 *
 *   RUN_AUTOMATION_WA_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/automation/wa-tenant-scope.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { dispatch } from "@/lib/messaging/providers"
import { actionSendWa } from "./actions"

vi.mock("@/lib/messaging/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/providers")>()),
  dispatch: vi.fn(),
}))

const RUN = process.env.RUN_AUTOMATION_WA_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const tenantA = `tenant_wa_scope_a_${token}`
const tenantB = `tenant_wa_scope_b_${token}`
const loanId = `loan_wa_scope_${token}`
const scheduleId = `sched_wa_scope_${token}`
const clientId = `client_wa_scope_${token}`
const productId = `product_wa_scope_${token}`
const applicationId = `app_wa_scope_${token}`
let errorSpy: ReturnType<typeof vi.spyOn>

const overdueRule = { id: `rule_${token}`, name: "1d overdue", description: null, actionConfig: { templateKey: "payment_overdue_1d" } }
const dueRule = { id: `rule_due_${token}`, name: "due 3d", description: null, actionConfig: { templateKey: "payment_due_3d" } }

const messageCount = (tenantId: string) =>
  withoutTenantScope(() => prisma.message.count({ where: { tenantId } }))

suite("actionSendWa tenant scoping (real Postgres)", () => {
  beforeAll(async () => {
    await withoutTenantScope(async () => {
      await prisma.tenant.createMany({
        data: [
          { id: tenantA, slug: `wa-scope-a-${token}`, name: "WA scope A" },
          { id: tenantB, slug: `wa-scope-b-${token}`, name: "WA scope B" },
        ],
      })
      // Deliberately NO branchId: this is what every app-created client looks like.
      await prisma.client.create({
        data: {
          id: clientId,
          tenantId: tenantA,
          reference: `CLI-W-${token}`,
          idNumber: `W${token}`.slice(0, 13),
          firstName: "Synthetic",
          lastName: "Borrower",
          email: `wa-scope-${token}@test.invalid`,
          phone: "+27820000002",
        },
      })
      await prisma.contact.create({
        data: {
          id: `contact_wa_scope_${token}`,
          tenantId: tenantA,
          clientId,
          status: "CLIENT",
          firstSeenChannel: "WHATSAPP",
          primaryWaJid: "27820000002@s.whatsapp.net",
        },
      })
      await prisma.loanProduct.create({
        data: {
          id: productId,
          tenantId: tenantA,
          code: `WS-${token.slice(0, 10)}`,
          name: "WA scope product",
          productType: "PERSONAL",
          minAmount: 10_000,
          maxAmount: 1_000_000,
          minTermDays: 30,
          maxTermDays: 90,
          interestRatePm: 0.03,
          interestModel: "DAILY_ACCRUAL",
        },
      })
      await prisma.loanApplication.create({
        data: {
          id: applicationId,
          tenantId: tenantA,
          reference: `APP-W-${token}`,
          clientId,
          productId,
          appliedAmount: 100_000,
          appliedTermDays: 30,
        },
      })
      await prisma.loan.create({
        data: {
          id: loanId,
          tenantId: tenantA,
          reference: `LN-W-${token}`,
          applicationId,
          clientId,
          productId,
          principal: 100_000,
          totalInterest: 5_000,
          initiationFee: 0,
          totalRepayable: 105_000,
          outstandingPrincipal: 100_000,
          status: "DEFAULTED",
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          maturityDate: new Date("2026-07-31T00:00:00.000Z"),
          interestRatePm: 0.03,
          interestModel: "DAILY_ACCRUAL",
          monthlyServiceFee: 0,
          daysInArrears: 1,
          arrearsAmount: 10_000,
        },
      })
      await prisma.repaymentSchedule.create({
        data: {
          id: scheduleId,
          tenantId: tenantA,
          loanId,
          installmentNo: 1,
          dueDate: new Date("2026-08-01T00:00:00.000Z"),
          principalDue: 100_000,
          interestDue: 5_000,
          feesDue: 0,
          totalDue: 105_000,
        },
      })
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => errorSpy.mockRestore())

  it("messages a branchless client of the same tenant (loan)", async () => {
    vi.mocked(dispatch).mockResolvedValueOnce({ providerMessageId: `p_${token}`, acceptedAt: new Date() })
    const result = await withoutTenantScope(() =>
      actionSendWa(overdueRule, { type: "loan", id: loanId }, tenantA, { occurrenceKey: "dpd:1" }))
    expect(result).toMatchObject({ outcome: "sent" })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await messageCount(tenantA)).toBe(1)
  })

  it("messages a branchless client of the same tenant (schedule)", async () => {
    vi.mocked(dispatch).mockResolvedValueOnce({ providerMessageId: `p2_${token}`, acceptedAt: new Date() })
    const result = await withoutTenantScope(() =>
      actionSendWa(dueRule, { type: "schedule", id: scheduleId }, tenantA, { occurrenceKey: "due:1" }))
    expect(result).toMatchObject({ outcome: "sent" })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("refuses another tenant's loan and schedule: nothing reserved or dispatched", async () => {
    const before = await messageCount(tenantB)
    const loanResult = await withoutTenantScope(() =>
      actionSendWa(overdueRule, { type: "loan", id: loanId }, tenantB, { occurrenceKey: "dpd:x" }))
    const schedResult = await withoutTenantScope(() =>
      actionSendWa(dueRule, { type: "schedule", id: scheduleId }, tenantB, { occurrenceKey: "due:x" }))
    const refusal = { outcome: "failed", dispatchPhase: "PRE_RESERVATION", detail: "entity_not_found_or_cross_tenant" }
    expect(loanResult).toEqual(refusal)
    expect(schedResult).toEqual(refusal)
    expect(dispatch).not.toHaveBeenCalled()
    expect(await messageCount(tenantB)).toBe(before)
  })
})
