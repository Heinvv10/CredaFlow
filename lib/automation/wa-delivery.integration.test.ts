/**
 * Real-PostgreSQL proof that automation occurrences compose correctly with
 * sendMessage's durable business reservation and explicit re-arm path.
 * Run only against a throwaway, fully migrated database:
 *
 *   RUN_AUTOMATION_WA_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/automation/wa-delivery.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { ProviderDispatchError, dispatch } from "@/lib/messaging/providers"
import { actionSendWa, sendAutomationWaMessage } from "./actions"
import { replayAutomationLog } from "./engine"

vi.mock("@/lib/messaging/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/providers")>()),
  dispatch: vi.fn(),
}))

const RUN = process.env.RUN_AUTOMATION_WA_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_automation_wa_${token}`
const contactId = `contact_automation_wa_${token}`
const userId = `user_automation_wa_${token}`
let errorSpy: ReturnType<typeof vi.spyOn>

function deliver(args: {
  occurrenceKey: string
  rearm?: boolean
  actorUserId?: string
}) {
  return withoutTenantScope(() => sendAutomationWaMessage({
    ruleId: `rule_${token}`,
    entity: { type: "loan", id: `loan_${token}` },
    templateKey: "payment_overdue_7d",
    tenantId,
    contactId,
    toValue: "27820000000@s.whatsapp.net",
    message: "Synthetic automation delivery",
    options: {
      occurrenceKey: args.occurrenceKey,
      ...(args.rearm
        ? {
            rearmDefinitelyRejected: {
              userId: args.actorUserId ?? userId,
              userEmail: `automation-admin-${token}@example.test`,
              reason: "Synthetic operator corrected the rejected provider configuration",
            },
          }
        : {}),
    },
  }))
}

suite("automation WhatsApp occurrence delivery", () => {
  beforeAll(async () => {
    await withoutTenantScope(async () => {
      await prisma.tenant.create({
        data: { id: tenantId, slug: `automation-wa-${token}`, name: "Automation WA integration" },
      })
      await prisma.user.create({
        data: {
          id: userId,
          tenantId,
          email: `automation-admin-${token}@example.test`,
          password: "synthetic-test-only",
          role: "ADMIN",
        },
      })
      await prisma.contact.create({
        data: {
          id: contactId,
          tenantId,
          status: "LEAD",
          firstSeenChannel: "WHATSAPP",
          primaryWaJid: "27820000000@s.whatsapp.net",
        },
      })
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => errorSpy.mockRestore())

  it("fails closed when a tenant-scoped log references another tenant's rule", async () => {
    const tenantA = `tenant_automation_log_a_${token}`
    const tenantB = `tenant_automation_rule_b_${token}`
    const ruleB = `rule_cross_tenant_${token}`
    const logA = `log_cross_tenant_${token}`
    await withoutTenantScope(async () => {
      await prisma.tenant.createMany({
        data: [
          { id: tenantA, slug: `automation-log-a-${token}`, name: "Automation log tenant A" },
          { id: tenantB, slug: `automation-rule-b-${token}`, name: "Automation rule tenant B" },
        ],
      })
      await prisma.automationRule.create({
        data: {
          id: ruleB,
          tenantId: tenantB,
          name: "Cross-tenant rule fixture",
          trigger: "LEAD_STALE",
          condition: { days: 1 },
          action: "CREATE_AGENT_TASK",
        },
      })
      await prisma.automationLog.create({
        data: {
          id: logA,
          tenantId: tenantA,
          ruleId: ruleB,
          entityType: "lead",
          entityId: `lead_cross_tenant_${token}`,
          result: "failed",
          error: "Synthetic historical mismatch",
        },
      })
    })

    await expect(withoutTenantScope(() => replayAutomationLog(
      logA,
      tenantA,
      { userId, userEmail: `automation-admin-${token}@example.test` },
    ))).rejects.toThrow("Log entry not found")

    expect(await withoutTenantScope(() => prisma.agentTask.count({
      where: { tenantId: tenantA, createdByRuleId: ruleB },
    }))).toBe(0)
  })

  it("deduplicates one occurrence but creates and dispatches the next window", async () => {
    vi.mocked(dispatch)
      .mockResolvedValueOnce({ providerMessageId: `provider_first_${token}`, acceptedAt: new Date() })
      .mockResolvedValueOnce({ providerMessageId: `provider_next_${token}`, acceptedAt: new Date() })

    const first = await deliver({ occurrenceKey: "dpd_threshold:window:100" })
    const duplicate = await deliver({ occurrenceKey: "dpd_threshold:window:100" })
    const next = await deliver({ occurrenceKey: "dpd_threshold:window:101" })

    expect(first).toEqual({
      outcome: "sent",
      messageId: expect.any(String),
      dispatchPhase: "PROVIDER_ACCEPTED",
    })
    expect(duplicate).toEqual(first)
    expect(next).toEqual({
      outcome: "sent",
      messageId: expect.any(String),
      dispatchPhase: "PROVIDER_ACCEPTED",
    })
    expect(next.messageId).not.toBe(first.messageId)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(await withoutTenantScope(() => prisma.message.count({
      where: {
        tenantId,
        idempotencyKey: { startsWith: `automation-wa:rule_${token}:loan:loan_${token}` },
      },
    }))).toBe(2)
  })

  it("reuses the occurrence and re-arms only its definitely rejected Message", async () => {
    vi.mocked(dispatch)
      .mockRejectedValueOnce(new ProviderDispatchError(
        "WA sender returned 401: invalid token",
        "DEFINITELY_REJECTED",
      ))
      .mockResolvedValueOnce({ providerMessageId: `provider_rearmed_${token}`, acceptedAt: new Date() })

    const occurrenceKey = "dpd_threshold:window:200"
    const failed = await deliver({ occurrenceKey })
    const duplicate = await deliver({ occurrenceKey })
    const beforeRearm = await withoutTenantScope(() => prisma.message.findFirstOrThrow({
      where: {
        tenantId,
        idempotencyKey: { endsWith: `:${occurrenceKey}` },
      },
    }))

    expect(failed.outcome).toBe("failed")
    expect(duplicate).toEqual({
      outcome: "failed",
      messageId: beforeRearm.id,
      dispatchPhase: "DEFINITELY_REJECTED",
    })
    expect(beforeRearm).toEqual(expect.objectContaining({
      status: "FAILED_PERMANENT",
      dispatchState: "DEFINITELY_REJECTED",
    }))
    expect(dispatch).toHaveBeenCalledTimes(1)

    const rearmed = await deliver({ occurrenceKey, rearm: true })
    const afterRearm = await withoutTenantScope(() => prisma.message.findFirstOrThrow({
      where: { id: beforeRearm.id, tenantId },
    }))

    expect(rearmed).toEqual({
      outcome: "sent",
      messageId: beforeRearm.id,
      dispatchPhase: "PROVIDER_ACCEPTED",
    })
    expect(afterRearm).toEqual(expect.objectContaining({
      id: beforeRearm.id,
      status: "SENT",
      dispatchState: "ACCEPTED",
      dispatchAttempt: beforeRearm.dispatchAttempt + 1,
    }))
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(await withoutTenantScope(() => prisma.message.count({
      where: { tenantId, idempotencyKey: { endsWith: `:${occurrenceKey}` } },
    }))).toBe(1)
    expect(await withoutTenantScope(() => prisma.auditLog.count({
      where: {
        tenantId,
        userId,
        entityId: beforeRearm.id,
        action: "MESSAGE_DISPATCH_REARMED",
      },
    }))).toBe(1)
  })

  it("rolls the re-arm back and never dispatches when its actor audit is invalid", async () => {
    vi.mocked(dispatch).mockRejectedValueOnce(new ProviderDispatchError(
      "WA sender returned 401: invalid token",
      "DEFINITELY_REJECTED",
    ))
    const occurrenceKey = "dpd_threshold:window:300"
    await deliver({ occurrenceKey })
    const before = await withoutTenantScope(() => prisma.message.findFirstOrThrow({
      where: { tenantId, idempotencyKey: { endsWith: `:${occurrenceKey}` } },
    }))

    const outcome = await deliver({
      occurrenceKey,
      rearm: true,
      actorUserId: `missing_${token}`,
    })
    const after = await withoutTenantScope(() => prisma.message.findFirstOrThrow({
      where: { id: before.id, tenantId },
    }))

    expect(outcome).toEqual({
      outcome: "failed",
      messageId: before.id,
      dispatchPhase: "DEFINITELY_REJECTED",
      detail: "message_dispatch_failed",
    })
    expect(after).toEqual(expect.objectContaining({
      status: "FAILED_PERMANENT",
      dispatchState: "DEFINITELY_REJECTED",
      dispatchToken: before.dispatchToken,
      dispatchAttempt: before.dispatchAttempt,
    }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await withoutTenantScope(() => prisma.auditLog.count({
      where: { tenantId, entityId: before.id, action: "MESSAGE_DISPATCH_REARMED" },
    }))).toBe(0)
  })

  it("replays a repaired pre-reservation contact failure without a phantom Message re-arm", async () => {
    const branchId = `branch_replay_${token}`
    const clientId = `client_replay_${token}`
    const productId = `product_replay_${token}`
    const applicationId = `application_replay_${token}`
    const loanId = `loan_replay_${token}`
    const ruleId = `rule_replay_${token}`
    const occurrenceKey = "dpd_threshold:window:400"

    const rule = await withoutTenantScope(async () => {
      await prisma.branch.create({
        data: {
          id: branchId,
          tenantId,
          code: `R${token.slice(0, 10)}`,
          name: "Automation replay branch",
        },
      })
      await prisma.client.create({
        data: {
          id: clientId,
          tenantId,
          branchId,
          reference: `CLI-R-${token}`,
          idNumber: `R${token}`.slice(0, 13),
          firstName: "Synthetic",
          lastName: "Replay",
          email: `automation-replay-${token}@test.invalid`,
          phone: "+27820000001",
        },
      })
      await prisma.loanProduct.create({
        data: {
          id: productId,
          tenantId,
          code: `RP-${token.slice(0, 10)}`,
          name: "Automation replay product",
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
          tenantId,
          reference: `APP-R-${token}`,
          clientId,
          productId,
          appliedAmount: 100_000,
          appliedTermDays: 30,
          status: "DISBURSED",
        },
      })
      await prisma.loan.create({
        data: {
          id: loanId,
          tenantId,
          reference: `LN-R-${token}`,
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
          daysInArrears: 7,
          arrearsAmount: 10_000,
        },
      })
      return prisma.automationRule.create({
        data: {
          id: ruleId,
          tenantId,
          name: "Synthetic replay rule",
          trigger: "DPD_THRESHOLD",
          condition: { dpdThreshold: 7 },
          action: "SEND_WA",
          actionConfig: { templateKey: "payment_overdue_7d" },
          enabled: true,
        },
      })
    })

    const failed = await withoutTenantScope(() => actionSendWa(
      rule,
      { type: "loan", id: loanId },
      tenantId,
      { occurrenceKey },
    ))
    expect(failed).toEqual({
      outcome: "failed",
      dispatchPhase: "PRE_RESERVATION",
      detail: "contact_missing",
    })
    const failedLog = await withoutTenantScope(() => prisma.automationLog.create({
      data: {
        tenantId,
        ruleId,
        entityType: "loan",
        entityId: loanId,
        result: failed.outcome,
        error: failed.detail,
        occurrenceKey,
        dispatchPhase: failed.dispatchPhase,
      },
    }))

    await withoutTenantScope(() => prisma.contact.create({
      data: {
        tenantId,
        clientId,
        status: "LEAD",
        firstSeenChannel: "WHATSAPP",
        primaryWaJid: "27820000001@s.whatsapp.net",
      },
    }))
    vi.mocked(dispatch).mockResolvedValueOnce({
      providerMessageId: `provider_repaired_${token}`,
      acceptedAt: new Date("2026-07-22T19:00:00.000Z"),
    })

    const replay = await withoutTenantScope(() => replayAutomationLog(
      failedLog.id,
      tenantId,
      { userId, userEmail: `automation-admin-${token}@example.test` },
    ))

    expect(replay).toEqual({ result: "sent" })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const replayLog = await withoutTenantScope(() => prisma.automationLog.findFirstOrThrow({
      where: { tenantId, ruleId, result: "sent" },
      orderBy: { createdAt: "desc" },
    }))
    expect(replayLog).toEqual(expect.objectContaining({
      occurrenceKey,
      dispatchPhase: "PROVIDER_ACCEPTED",
      messageId: expect.any(String),
    }))
    expect(await withoutTenantScope(() => prisma.message.count({
      where: {
        tenantId,
        idempotencyKey: `automation-wa:${ruleId}:loan:${loanId}:payment_overdue_7d:${occurrenceKey}`,
      },
    }))).toBe(1)
    expect(await withoutTenantScope(() => prisma.auditLog.count({
      where: { tenantId, action: "MESSAGE_DISPATCH_REARMED", entityId: replayLog.messageId },
    }))).toBe(0)
  })
})
