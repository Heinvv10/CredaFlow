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
  },
}))
vi.mock("./built-in-rules", () => ({ ensureBuiltInRules: vi.fn() }))
vi.mock("./actions", () => ({
  actionCreateTask: vi.fn(),
  actionCreateOpportunity: vi.fn(),
}))

import { replayAutomationLog, runAutomationEngine } from "./engine"
import { prisma } from "@/lib/prisma"
import { actionCreateTask } from "./actions"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.automationLog.create).mockResolvedValue({} as any)
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

    const result = await replayAutomationLog("log1", "tenant-a")

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

    const result = await replayAutomationLog("log1", "tenant-a")

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

    await expect(replayAutomationLog("log-cross-tenant-rule", "tenant-a")).rejects.toThrow("Log entry not found")

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

describe("SEND_WA rule rows are retired (the reminders cron owns WhatsApp)", () => {
  const waRule = {
    id: "rule-wa", tenantId: "tenant-a", name: "Legacy WA rule", description: null, trigger: "DPD_THRESHOLD",
    condition: { dpdThreshold: 7 }, action: "SEND_WA", actionConfig: { templateKey: "payment_overdue_7d" },
    enabled: true, isBuiltIn: true,
  }

  it("skips the rule without evaluating it and logs the reason once per rule", async () => {
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([waRule] as any)
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue(null)

    const result = await runAutomationEngine("tenant-a")

    expect(result).toEqual({ ran: 0, actions: 0, errors: 0 })
    expect(prisma.loan.findMany).not.toHaveBeenCalled()
    expect(prisma.automationLog.create).toHaveBeenCalledTimes(1)
    expect(prisma.automationLog.create).toHaveBeenCalledWith({
      data: {
        ruleId: "rule-wa", tenantId: "tenant-a", entityType: "rule", entityId: "rule-wa",
        result: "skipped", error: "whatsapp_reminders_handled_by_reminders_cron",
      },
    })
  })

  it("does not log again on the next run", async () => {
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([waRule] as any)
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({ id: "log-1" } as any)

    await runAutomationEngine("tenant-a")

    expect(prisma.automationLog.create).not.toHaveBeenCalled()
  })

  it("still runs the non-WhatsApp rules beside it", async () => {
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([
      waRule,
      { ...waRule, id: "rule-task", action: "CREATE_AGENT_TASK", actionConfig: {} },
    ] as any)
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.automationPause.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.loan.findMany).mockResolvedValue([
      { id: "loan-1", reference: "LN-1", status: "DEFAULTED", ncaRegime: "NCA", daysInArrears: 7, arrearsAmount: 100, outstandingPrincipal: 100 },
    ] as any)

    const result = await runAutomationEngine("tenant-a")

    expect(result).toEqual({ ran: 1, actions: 1, errors: 0 })
    expect(actionCreateTask).toHaveBeenCalledTimes(1)
  })

  it("refuses to replay a failed SEND_WA log", async () => {
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({
      id: "log1", tenantId: "tenant-a", ruleId: "rule-wa", entityType: "loan", entityId: "loan-1", result: "failed",
      rule: waRule,
    } as any)

    await expect(replayAutomationLog("log1", "tenant-a")).rejects.toThrow(/handled by the reminders cron/)
    expect(actionCreateTask).not.toHaveBeenCalled()
  })

  it.each(["PAYMENT_DUE", "LOAN_PAID_IN_FULL"] as const)("skips a %s rule once: its evaluator is gone", async (trigger) => {
    vi.mocked(prisma.automationRule.findMany).mockResolvedValue([
      { ...waRule, id: "rule-x", trigger, action: "NOTIFY_AGENT" },
    ] as any)
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValueOnce(null)

    const result = await runAutomationEngine("tenant-a")

    expect(result).toEqual({ ran: 0, actions: 0, errors: 0 })
    expect(prisma.automationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ruleId: "rule-x", entityType: "rule", result: "skipped", error: "no_evaluator_for_trigger" }),
    })

    vi.mocked(prisma.automationLog.create).mockClear()
    vi.mocked(prisma.automationLog.findFirst).mockResolvedValue({ id: "log-1" } as any)
    await runAutomationEngine("tenant-a")
    expect(prisma.automationLog.create).not.toHaveBeenCalled()
  })
})

