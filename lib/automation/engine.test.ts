/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRule: { findMany: vi.fn() },
    automationLog: { findFirst: vi.fn(), create: vi.fn() },
    automationPause: { findUnique: vi.fn() },
    lead: { findFirst: vi.fn(), findMany: vi.fn() },
    loan: { findFirst: vi.fn(), findMany: vi.fn() },
    repaymentSchedule: { findMany: vi.fn() },
    message: { findFirst: vi.fn() },
  },
}))
vi.mock("./built-in-rules", () => ({ ensureBuiltInRules: vi.fn() }))
vi.mock("./actions", () => ({
  actionSendWa: vi.fn(),
  actionCreateTask: vi.fn(),
  actionCreateOpportunity: vi.fn(),
  automationWaIdempotencyKey: vi.fn((args: {
    ruleId: string
    entity: { type: string; id: string }
    templateKey: string
    occurrenceKey: string
  }) => `automation-wa:${args.ruleId}:${args.entity.type}:${args.entity.id}:${args.templateKey}:${args.occurrenceKey}`),
}))

import { replayAutomationLog, runAutomationEngine } from "./engine"
import { prisma } from "@/lib/prisma"
import { actionCreateTask, actionSendWa } from "./actions"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.automationLog.create).mockResolvedValue({} as any)
  vi.mocked(actionSendWa).mockResolvedValue({
    outcome: "sent",
    messageId: "message-1",
    dispatchPhase: "PROVIDER_ACCEPTED",
  })
  vi.mocked(prisma.message.findFirst).mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("replayAutomationLog — LEAD_STALE tenant scoping", () => {
  it("scopes the lead lookup to the log's tenant, not just the raw id", async () => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log1",
      ruleId: "rule1",
      entityType: "lead",
      entityId: "lead1",
      result: "failed",
      tenantId: "tenant-a",
      rule: { id: "rule1", tenantId: "tenant-a", trigger: "LEAD_STALE" },
    } as any)
    vi.mocked(prisma.automationPause.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.lead.findFirst).mockResolvedValue({ firstName: "Jane", lastName: "Doe" } as any)
    vi.mocked(prisma.automationLog.create).mockResolvedValue({} as any)

    const result = await replayAutomationLog("log1", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })

    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: "lead1", tenantId: "tenant-a" },
      select: { firstName: true, lastName: true },
    })
    expect(result).toEqual({ result: "success" })
    expect(actionCreateTask).toHaveBeenCalled()
  })

  it("treats a lead belonging to another tenant as not found", async () => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log1",
      ruleId: "rule1",
      entityType: "lead",
      entityId: "lead1",
      result: "failed",
      tenantId: "tenant-a",
      rule: { id: "rule1", tenantId: "tenant-a", trigger: "LEAD_STALE" },
    } as any)
    vi.mocked(prisma.automationPause.findUnique).mockResolvedValue(null)
    // Cross-tenant id: findFirst scoped by tenantId returns null even though the row exists.
    vi.mocked(prisma.lead.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.automationLog.create).mockResolvedValue({} as any)

    const result = await replayAutomationLog("log1", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })

    expect(result).toEqual({ result: "failed", error: "Error: Lead not found" })
    expect(actionCreateTask).not.toHaveBeenCalled()
  })

  it("rejects a tenant-scoped log whose related rule belongs to another tenant", async () => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log-cross-tenant-rule",
      tenantId: "tenant-a",
      ruleId: "rule-b",
      entityType: "lead",
      entityId: "lead1",
      result: "failed",
      rule: { id: "rule-b", tenantId: "tenant-b", trigger: "LEAD_STALE" },
    } as any)

    await expect(replayAutomationLog("log-cross-tenant-rule", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })).rejects.toThrow("Log entry not found")

    expect(prisma.automationLog.findFirst).toHaveBeenCalledWith({
      where: { id: "log-cross-tenant-rule", tenantId: "tenant-a", rule: { tenantId: "tenant-a" } },
      include: { rule: true },
    })
    expect(prisma.automationPause.findUnique).not.toHaveBeenCalled()
    expect(actionCreateTask).not.toHaveBeenCalled()
    expect(prisma.automationLog.create).not.toHaveBeenCalled()
  })
})

describe("Section 129 automation eligibility", () => {
  it("uses the 90-DPD boundary and never creates a task for stale or settled balances", async () => {
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([{
      id: "rule-s129",
      tenantId: "tenant-a",
      name: "DPD 90 — Section 129 task",
      description: "Review Section 129 eligibility",
      trigger: "DPD_THRESHOLD",
      condition: { dpdThreshold: 90 },
      action: "ISSUE_SECTION_129",
      actionConfig: {},
      enabled: true,
      isBuiltIn: true,
    }] as any)
    vi.mocked(prisma.loan.findMany).mockResolvedValue([
      { id: "loan-89", reference: "LN-89", status: "DEFAULTED", daysInArrears: 89, arrearsAmount: 100, outstandingPrincipal: 100 },
      { id: "loan-90", reference: "LN-90", status: "DEFAULTED", daysInArrears: 90, arrearsAmount: 100, outstandingPrincipal: 100 },
      { id: "loan-settled", reference: "LN-SETTLED", status: "DEFAULTED", daysInArrears: 100, arrearsAmount: 0, outstandingPrincipal: 0 },
    ] as any)
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.automationPause.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.automationLog.create).mockResolvedValue({} as any)
    vi.mocked(actionCreateTask).mockResolvedValue(undefined)

    const result = await runAutomationEngine("tenant-a")

    expect(prisma.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        daysInArrears: { gte: 90 },
        arrearsAmount: { gt: 0 },
        outstandingPrincipal: { gt: 0 },
      }),
    }))
    expect(actionCreateTask).toHaveBeenCalledTimes(1)
    expect(actionCreateTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "loan-90" }),
      "tenant-a",
    )
    expect(result).toEqual({ ran: 1, actions: 1, errors: 0 })
  })
})

describe("SEND_WA automation outcomes", () => {
  const waRule = {
    id: "rule-wa",
    tenantId: "tenant-a",
    name: "DPD WhatsApp",
    description: "Send an arrears reminder",
    trigger: "DPD_THRESHOLD",
    condition: { dpdThreshold: 7 },
    action: "SEND_WA",
    actionConfig: { templateKey: "payment_overdue_7d" },
    enabled: true,
    isBuiltIn: true,
  }

  beforeEach(() => {
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([waRule] as any)
    vi.mocked(prisma.loan.findMany).mockResolvedValue([{
      id: "loan-wa",
      reference: "LN-WA",
      status: "DEFAULTED",
      daysInArrears: 7,
      arrearsAmount: 100,
      outstandingPrincipal: 100,
    }] as any)
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.automationPause.findUnique).mockResolvedValue(null)
  })

  it.each([
    ["simulated", "message-sim", "SIMULATED"],
    ["reconciliation_required", "message-ambiguous", "RECONCILIATION_REQUIRED"],
  ] as const)("records %s truthfully and never as success", async (outcome, messageId, dispatchPhase) => {
    vi.mocked(actionSendWa).mockResolvedValue({ outcome, messageId, dispatchPhase })

    const result = await runAutomationEngine("tenant-a")

    expect(result).toEqual({ ran: 1, actions: 0, errors: 0 })
    expect(prisma.automationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleId: "rule-wa",
        entityId: "loan-wa",
        result: outcome,
        messageId,
        dispatchPhase,
      }),
    })
    expect(prisma.automationLog.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ result: "success" }),
    })
  })

  it("records a failed send without counting it as an action or suppressing a later retry", async () => {
    vi.mocked(actionSendWa).mockResolvedValue({
      outcome: "failed",
      dispatchPhase: "PRE_RESERVATION",
      detail: "message_dispatch_failed",
    })

    const result = await runAutomationEngine("tenant-a")

    expect(result).toEqual({ ran: 1, actions: 0, errors: 0 })
    expect(prisma.automationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleId: "rule-wa",
        entityId: "loan-wa",
        result: "failed",
        dispatchPhase: "PRE_RESERVATION",
        error: "message_dispatch_failed",
      }),
    })
    const query = vi.mocked(prisma.automationLog.findFirst).mock.calls[0]?.[0]
    const resultFilter = query?.where?.result as { in: string[] } | undefined
    expect(resultFilter?.in).not.toContain("failed")
  })

  it("assigns a new durable business key to the next cooldown occurrence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"))

    await runAutomationEngine("tenant-a")
    const firstOptions = vi.mocked(actionSendWa).mock.calls[0]?.[3]
    const firstLog = vi.mocked(prisma.automationLog.create).mock.calls[0]?.[0]?.data

    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"))
    await runAutomationEngine("tenant-a")
    const secondOptions = vi.mocked(actionSendWa).mock.calls[1]?.[3]
    const secondLog = vi.mocked(prisma.automationLog.create).mock.calls[1]?.[0]?.data

    expect(firstOptions?.occurrenceKey).toBe("dpd_threshold:window:20656")
    expect(secondOptions?.occurrenceKey).toBe("dpd_threshold:window:20657")
    expect(secondOptions?.occurrenceKey).not.toBe(firstOptions?.occurrenceKey)
    expect(firstLog?.occurrenceKey).toBe(firstOptions?.occurrenceKey)
    expect(secondLog?.occurrenceKey).toBe(secondOptions?.occurrenceKey)
  })

  it("manual replay reuses the failed occurrence and requests only definite-rejection re-arm", async () => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log-wa-failed",
      tenantId: "tenant-a",
      ruleId: "rule-wa",
      entityType: "loan",
      entityId: "loan-wa",
      result: "failed",
      occurrenceKey: "dpd_threshold:window:20656",
      messageId: "message-rejected",
      dispatchPhase: "DEFINITELY_REJECTED",
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      rule: waRule,
    } as any)
    vi.mocked(prisma.loan.findFirst).mockResolvedValue({
      id: "loan-wa",
      reference: "LN-WA",
      status: "DEFAULTED",
      daysInArrears: 7,
      arrearsAmount: 100,
      outstandingPrincipal: 100,
    } as any)
    vi.mocked(prisma.message.findFirst).mockResolvedValue({ id: "message-rejected" } as any)
    vi.mocked(actionSendWa).mockResolvedValue({
      outcome: "sent",
      messageId: "message-rearmed",
      dispatchPhase: "PROVIDER_ACCEPTED",
    })

    const result = await replayAutomationLog("log-wa-failed", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })

    expect(result).toEqual({ result: "sent" })
    expect(actionSendWa).toHaveBeenCalledWith(
      waRule,
      { type: "loan", id: "loan-wa" },
      "tenant-a",
      {
        occurrenceKey: "dpd_threshold:window:20656",
        rearmDefinitelyRejected: {
          userId: "admin-1",
          userEmail: "admin@example.test",
          reason: "Manual replay of failed automation log log-wa-failed",
        },
      },
    )
    expect(prisma.automationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        result: "sent",
        occurrenceKey: "dpd_threshold:window:20656",
        messageId: "message-rearmed",
        dispatchPhase: "PROVIDER_ACCEPTED",
      }),
    })
  })

  it("replays a repaired pre-reservation failure without requesting a Message re-arm", async () => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log-wa-contact-missing",
      tenantId: "tenant-a",
      ruleId: "rule-wa",
      entityType: "loan",
      entityId: "loan-wa",
      result: "failed",
      occurrenceKey: "dpd_threshold:window:20656",
      messageId: null,
      dispatchPhase: "PRE_RESERVATION",
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      rule: waRule,
    } as any)
    vi.mocked(prisma.loan.findFirst).mockResolvedValue({
      id: "loan-wa",
      reference: "LN-WA",
      status: "DEFAULTED",
      daysInArrears: 7,
      arrearsAmount: 100,
      outstandingPrincipal: 100,
    } as any)

    const result = await replayAutomationLog("log-wa-contact-missing", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })

    expect(result).toEqual({ result: "sent" })
    expect(actionSendWa).toHaveBeenCalledWith(
      waRule,
      { type: "loan", id: "loan-wa" },
      "tenant-a",
      { occurrenceKey: "dpd_threshold:window:20656" },
    )
    expect(prisma.message.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    [null, null, "legacy evidence is absent"],
    ["UNKNOWN", null, "the dispatch phase is unknown"],
    ["DEFINITELY_REJECTED", "message-wrong", "the Message evidence does not match"],
  ] as const)("fails closed when %s/%s: %s", async (dispatchPhase, messageId, _reason) => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log-wa-unsafe",
      tenantId: "tenant-a",
      ruleId: "rule-wa",
      entityType: "loan",
      entityId: "loan-wa",
      result: "failed",
      occurrenceKey: "dpd_threshold:window:20656",
      messageId,
      dispatchPhase,
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      rule: waRule,
    } as any)

    const result = await replayAutomationLog("log-wa-unsafe", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })

    expect(result).toMatchObject({ result: "failed", error: expect.stringContaining("replay blocked") })
    expect(actionSendWa).not.toHaveBeenCalled()
  })

  it("keeps the failed occurrence when replay preparation throws in a later window", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-30T12:00:00.000Z"))
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log-wa-old",
      tenantId: "tenant-a",
      ruleId: "rule-wa",
      entityType: "loan",
      entityId: "loan-wa",
      result: "failed",
      occurrenceKey: "dpd_threshold:window:20656",
      messageId: null,
      dispatchPhase: "PRE_RESERVATION",
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      rule: waRule,
    } as any)
    vi.mocked(prisma.loan.findFirst).mockResolvedValue({
      id: "loan-wa",
      reference: "LN-WA",
      status: "DEFAULTED",
      daysInArrears: 7,
      arrearsAmount: 100,
      outstandingPrincipal: 100,
    } as any)
    vi.mocked(actionSendWa).mockRejectedValue(new Error("template preparation failed"))

    const result = await replayAutomationLog("log-wa-old", "tenant-a", {
      userId: "admin-1",
      userEmail: "admin@example.test",
    })

    expect(result).toMatchObject({ result: "failed", error: expect.stringContaining("template preparation failed") })
    expect(prisma.automationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        result: "failed",
        occurrenceKey: "dpd_threshold:window:20656",
      }),
    })
  })

  it("deduplicates only appropriate prior outcomes, not failed attempts", async () => {
    await runAutomationEngine("tenant-a")

    expect(prisma.automationLog.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        ruleId: "rule-wa",
        entityId: "loan-wa",
        result: {
          in: expect.arrayContaining([
            "sent",
            "simulated",
            "pending",
            "blocked",
            "reconciliation_required",
          ]),
        },
      }),
    })
    const query = vi.mocked(prisma.automationLog.findFirst).mock.calls[0]?.[0]
    const resultFilter = query?.where?.result as { in: string[] } | undefined
    expect(resultFilter?.in).not.toContain("failed")
  })
})

describe("PAYMENT_DUE — SAST day window", () => {
  afterEach(() => vi.useRealTimers())

  async function windowFor(nowIso: string, paymentDueDays = 3) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(nowIso))
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([
      {
        id: "rule-pd", tenantId: "tenant-a", name: "Payment due", enabled: true,
        trigger: "PAYMENT_DUE", condition: { paymentDueDays },
        action: "SEND_WA", actionConfig: {},
      },
    ] as any)
    vi.mocked(prisma.repaymentSchedule.findMany).mockResolvedValue([] as any)
    await runAutomationEngine("tenant-a")
    const call = vi.mocked(prisma.repaymentSchedule.findMany).mock.calls.at(-1)?.[0] as any
    return call.where.dueDate as { gte: Date; lt?: Date; lte?: Date }
  }

  it("skips instalments of a loan whose disbursement was reversed (CANCELLED)", async () => {
    await windowFor("2026-08-20T09:00:00Z")
    const call = vi.mocked(prisma.repaymentSchedule.findMany).mock.calls.at(-1)?.[0] as any
    expect(call.where.loan).toEqual({ status: { not: "CANCELLED" } })
  })

  it("targets the SAST calendar day, not the container's UTC one", async () => {
    // now = 2026-08-17T22:30Z is 00:30 SAST on 18 Aug, so "3 days from now" is
    // 21 August in Johannesburg. Local-midnight arithmetic on a UTC container
    // produced the 20th and the rule fired a day early, every night between
    // midnight and 02:00.
    const w = await windowFor("2026-08-17T22:30:00Z")
    expect(w.gte.toISOString()).toBe("2026-08-20T22:00:00.000Z") // 21 Aug 00:00 SAST
    expect(w.lt!.toISOString()).toBe("2026-08-21T22:00:00.000Z") // 22 Aug 00:00 SAST
  })

  it("is end-EXCLUSIVE, so an instalment due in the day's last millisecond counts", async () => {
    // The window closed at 23:59:59.999 with `lte`, so a dueDate at
    // 23:59:59.9995 — or any timestamp with sub-millisecond precision from the
    // database — fell outside a window that claims to cover the whole day.
    const w = await windowFor("2026-08-20T09:00:00Z")
    expect(w.lte).toBeUndefined()
    expect(w.lt).toBeInstanceOf(Date)
    expect(w.lt!.getTime() - w.gte.getTime()).toBe(24 * 60 * 60 * 1000)
  })
})
