import { prisma } from "@/lib/prisma"
import { ensureBuiltInRules } from "./built-in-rules"
import {
  actionSendWa,
  actionCreateTask,
  actionCreateOpportunity,
  automationWaIdempotencyKey,
  type AutomationWaDispatchOptions,
  type AutomationWaResult,
} from "./actions"
import type { AutomationRule } from "@prisma/client"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { automationCooldownMs, automationOccurrenceKey } from "./occurrence"
import { sastStartOfDay } from "@/lib/date/sast"
import { requireClientBorrowerId } from "@/lib/borrower"

type AutomationLogResult =
  | "success"
  | "sent"
  | "simulated"
  | "pending"
  | "blocked"
  | "reconciliation_required"
  | "failed"
  | "skipped"

const RESULTS_THAT_OCCUPY_COOLDOWN: readonly AutomationLogResult[] = [
  "success",
  "sent",
  "simulated",
  "pending",
  "blocked",
  "reconciliation_required",
  "skipped",
]

async function alreadyFired(ruleId: string, entityId: string, trigger: string): Promise<boolean> {
  const coolDown = automationCooldownMs(trigger)
  const since = new Date(Date.now() - coolDown)
  const existing = await prisma.automationLog.findFirst({
    where: {
      ruleId,
      entityId,
      result: { in: [...RESULTS_THAT_OCCUPY_COOLDOWN] },
      createdAt: { gte: since },
    },
  })
  return !!existing
}

async function isPaused(ruleId: string, entityId: string): Promise<boolean> {
  const pause = await prisma.automationPause.findUnique({
    where: { ruleId_entityId: { ruleId, entityId } },
    select: { id: true },
  })
  return !!pause
}

async function writeLog(opts: {
  ruleId: string; tenantId: string; entityType: string; entityId: string
  result: AutomationLogResult; error?: string; occurrenceKey?: string
  messageId?: string; dispatchPhase?: AutomationWaResult["dispatchPhase"]
}) {
  await prisma.automationLog.create({ data: opts }).catch((err: unknown) => {
    // Log write failures must not crash the engine, but surface them
    console.error("[automation] Failed to write log:", err)
  })
}

async function writeWaLog(args: {
  rule: AutomationRule
  entityType: string
  entityId: string
  occurrenceKey: string
  outcome: AutomationWaResult
}): Promise<boolean> {
  await writeLog({
    ruleId: args.rule.id,
    tenantId: args.rule.tenantId,
    entityType: args.entityType,
    entityId: args.entityId,
    occurrenceKey: args.occurrenceKey,
    result: args.outcome.outcome,
    ...(args.outcome.messageId ? { messageId: args.outcome.messageId } : {}),
    dispatchPhase: args.outcome.dispatchPhase,
    ...(args.outcome.detail ? { error: args.outcome.detail } : {}),
  })
  return args.outcome.outcome === "sent"
}

// ── Trigger evaluators ────────────────────────────────────────────────────────

async function evaluateLeadStale(rule: AutomationRule): Promise<number> {
  const cond = rule.condition as { staleHours?: number }
  const staleHours = cond.staleHours ?? 48
  const staleSince = new Date(Date.now() - staleHours * 60 * 60 * 1000)

  const leads = await prisma.lead.findMany({
    where: {
      tenantId: rule.tenantId,
      status: { notIn: ["CONVERTED", "LOST"] },
      updatedAt: { lt: staleSince },
    },
    select: { id: true, firstName: true, lastName: true },
  })

  let fired = 0
  for (const lead of leads) {
    if (await alreadyFired(rule.id, lead.id, rule.trigger)) continue
    if (await isPaused(rule.id, lead.id)) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "lead", entityId: lead.id, result: "skipped", error: "paused" })
      continue
    }
    try {
      await actionCreateTask(rule, { type: "lead", id: lead.id, ref: `${lead.firstName} ${lead.lastName}` }, rule.tenantId)
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "lead", entityId: lead.id, result: "success" })
      fired++
    } catch (err) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "lead", entityId: lead.id, result: "failed", error: String(err) })
    }
  }
  return fired
}

async function evaluateDpdThreshold(rule: AutomationRule): Promise<number> {
  const cond = rule.condition as { dpdThreshold?: number }
  const threshold = cond.dpdThreshold ?? 0

  const loans = await prisma.loan.findMany({
    where: {
      tenantId: rule.tenantId,
      status: { in: ["ACTIVE", "DEFAULTED"] },
      daysInArrears: { gte: threshold },
      arrearsAmount: { gt: 0 },
      outstandingPrincipal: { gt: 0 },
    },
    select: {
      id: true,
      reference: true,
      status: true,
      ncaRegime: true,
      daysInArrears: true,
      arrearsAmount: true,
      outstandingPrincipal: true,
    },
  })

  let fired = 0
  for (const loan of loans) {
    if (await alreadyFired(rule.id, loan.id, rule.trigger)) continue
    if (await isPaused(rule.id, loan.id)) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: loan.id, result: "skipped", error: "paused" })
      continue
    }
    if (rule.action === "ISSUE_SECTION_129") {
      const eligibility = evaluateCollectionsEligibility(loan, "SECTION_129")
      if (!eligibility.eligible) {
        await writeLog({
          ruleId: rule.id,
          tenantId: rule.tenantId,
          entityType: "loan",
          entityId: loan.id,
          result: "skipped",
          error: eligibility.reason ?? "not eligible for Section 129",
        })
        continue
      }
    }
    try {
      switch (rule.action) {
        case "SEND_WA": {
          const occurrenceKey = automationOccurrenceKey(rule.trigger)
          if (await writeWaLog({
            rule,
            entityType: "loan",
            entityId: loan.id,
            occurrenceKey,
            outcome: await actionSendWa(
              rule,
              { type: "loan", id: loan.id },
              rule.tenantId,
              { occurrenceKey },
            ),
          })) fired++
          continue
        }
        case "CREATE_AGENT_TASK":
        case "ISSUE_SECTION_129":
        case "NOTIFY_AGENT":
          await actionCreateTask(rule, { type: "loan", id: loan.id, ref: loan.reference }, rule.tenantId)
          break
      }
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: loan.id, result: "success" })
      fired++
    } catch (err) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: loan.id, result: "failed", error: String(err) })
    }
  }
  return fired
}

async function evaluatePaymentDue(rule: AutomationRule): Promise<number> {
  const cond = rule.condition as { paymentDueDays?: number }
  const days = cond.paymentDueDays ?? 3
  const now = new Date()
  const target = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  // The SAST day `days` from now, end-EXCLUSIVE. This was a local-midnight
  // window closing at 23:59:59.999, which both sat two hours off the South
  // African day and could drop an instalment due in its final millisecond.
  const dayStart = sastStartOfDay(target)
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  const schedules = await prisma.repaymentSchedule.findMany({
    where: {
      tenantId: rule.tenantId,
      dueDate: { gte: dayStart, lt: dayEnd },
      status: { in: ["PENDING", "PARTIAL"] },
    },
    select: { id: true },
  })

  let fired = 0
  for (const s of schedules) {
    if (await alreadyFired(rule.id, s.id, rule.trigger)) continue
    if (await isPaused(rule.id, s.id)) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "schedule", entityId: s.id, result: "skipped", error: "paused" })
      continue
    }
    try {
      const occurrenceKey = automationOccurrenceKey(rule.trigger)
      if (await writeWaLog({
        rule,
        entityType: "schedule",
        entityId: s.id,
        occurrenceKey,
        outcome: await actionSendWa(
          rule,
          { type: "schedule", id: s.id },
          rule.tenantId,
          { occurrenceKey },
        ),
      })) fired++
    } catch (err) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "schedule", entityId: s.id, result: "failed", error: String(err) })
    }
  }
  return fired
}

async function evaluateLoanPaidOnTimeN(rule: AutomationRule): Promise<number> {
  const cond = rule.condition as { onTimeCount?: number }
  const n = cond.onTimeCount ?? 3

  const paidOnTime = await prisma.repaymentSchedule.findMany({
    where: {
      tenantId: rule.tenantId,
      installmentNo: n,
      status: "PAID",
      paidAt: { not: null },
      loan: { status: "ACTIVE" },
    },
    select: {
      id: true, dueDate: true, paidAt: true, loanId: true,
      loan: { select: { clientId: true } },
    },
  })

  let fired = 0
  for (const s of paidOnTime) {
    if (!s.paidAt || s.paidAt > s.dueDate) continue
    // Cross-sell opportunities attach to a Client; an entity borrower has none.
    const clientId = s.loan.clientId
    if (clientId === null) continue
    if (await alreadyFired(rule.id, s.loanId, rule.trigger)) continue
    if (await isPaused(rule.id, s.loanId)) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: s.loanId, result: "skipped", error: "paused" })
      continue
    }
    try {
      await actionCreateOpportunity(rule, clientId, rule.tenantId)
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: s.loanId, result: "success" })
      fired++
    } catch (err) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: s.loanId, result: "failed", error: String(err) })
    }
  }
  return fired
}

async function evaluateLoanPaidInFull(rule: AutomationRule): Promise<number> {
  const loans = await prisma.loan.findMany({
    where: {
      tenantId: rule.tenantId,
      status: "COMPLETED",
    },
    select: { id: true, reference: true },
  })

  let fired = 0
  for (const loan of loans) {
    if (await alreadyFired(rule.id, loan.id, rule.trigger)) continue
    if (await isPaused(rule.id, loan.id)) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: loan.id, result: "skipped", error: "paused" })
      continue
    }
    try {
      const occurrenceKey = automationOccurrenceKey(rule.trigger)
      if (await writeWaLog({
        rule,
        entityType: "loan",
        entityId: loan.id,
        occurrenceKey,
        outcome: await actionSendWa(
          rule,
          { type: "loan", id: loan.id },
          rule.tenantId,
          { occurrenceKey },
        ),
      })) fired++
    } catch (err) {
      await writeLog({ ruleId: rule.id, tenantId: rule.tenantId, entityType: "loan", entityId: loan.id, result: "failed", error: String(err) })
    }
  }
  return fired
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runAutomationEngine(tenantId: string): Promise<{ ran: number; actions: number; errors: number }> {
  await ensureBuiltInRules(tenantId)

  const rules = await prisma.automationRule.findMany({ where: { tenantId, enabled: true } })
  let ran = 0, actions = 0, errors = 0

  for (const rule of rules) {
    try {
      let count = 0
      switch (rule.trigger) {
        case "LEAD_STALE":          count = await evaluateLeadStale(rule); break
        case "DPD_THRESHOLD":       count = await evaluateDpdThreshold(rule); break
        case "PAYMENT_DUE":         count = await evaluatePaymentDue(rule); break
        case "LOAN_PAID_ON_TIME_N": count = await evaluateLoanPaidOnTimeN(rule); break
        case "LOAN_PAID_IN_FULL":   count = await evaluateLoanPaidInFull(rule); break
      }
      ran++; actions += count
    } catch (err) {
      errors++
      // Engine errors are logged to cron caller, not swallowed
      console.error(`[automation] Rule ${rule.id} (${rule.name}) threw:`, err)
    }
  }

  return { ran, actions, errors }
}

// ── Replay a single failed log entry ─────────────────────────────────────────

async function waReplayOptions(args: {
  log: {
    id: string
    tenantId: string
    entityType: string
    entityId: string
    messageId: string | null
    dispatchPhase: string | null
  }
  rule: AutomationRule
  occurrenceKey: string
  actor: { userId: string; userEmail: string }
}): Promise<AutomationWaDispatchOptions> {
  if (args.log.dispatchPhase === "PRE_RESERVATION" && args.log.messageId === null) {
    return { occurrenceKey: args.occurrenceKey }
  }

  if (args.log.dispatchPhase !== "DEFINITELY_REJECTED" || !args.log.messageId) {
    throw new Error(
      "WhatsApp replay blocked: the failed log has no verified, safely replayable dispatch evidence",
    )
  }
  if (args.log.entityType !== "loan" && args.log.entityType !== "schedule") {
    throw new Error("WhatsApp replay blocked: unsupported automation entity type")
  }
  const templateKey = (args.rule.actionConfig as { templateKey?: unknown } | null)?.templateKey
  if (typeof templateKey !== "string" || templateKey.length === 0) {
    throw new Error("WhatsApp replay blocked: the original template key is unavailable")
  }
  const idempotencyKey = automationWaIdempotencyKey({
    ruleId: args.rule.id,
    entity: { type: args.log.entityType, id: args.log.entityId },
    templateKey,
    occurrenceKey: args.occurrenceKey,
  })
  const rejected = await prisma.message.findFirst({
    where: {
      id: args.log.messageId,
      tenantId: args.log.tenantId,
      idempotencyKey,
      dispatchState: "DEFINITELY_REJECTED",
      status: { in: ["FAILED", "FAILED_PERMANENT"] },
    },
    select: { id: true },
  })
  if (!rejected) {
    throw new Error(
      "WhatsApp replay blocked: the logged Message is missing, mismatched, or no longer definitely rejected",
    )
  }

  return {
    occurrenceKey: args.occurrenceKey,
    rearmDefinitelyRejected: {
      userId: args.actor.userId,
      userEmail: args.actor.userEmail,
      reason: `Manual replay of failed automation log ${args.log.id}`,
    },
  }
}

export async function replayAutomationLog(
  logId: string,
  tenantId: string,
  actor: { userId: string; userEmail: string },
): Promise<{ result: AutomationLogResult; error?: string }> {
  const log = await prisma.automationLog.findFirst({
    where: { id: logId, tenantId, rule: { tenantId } },
    include: { rule: true },
  })
  if (!log || log.rule.tenantId !== tenantId || log.rule.tenantId !== log.tenantId) {
    throw new Error("Log entry not found")
  }
  if (log.result !== "failed") throw new Error("Only failed log entries can be replayed")

  const { rule, entityType, entityId } = log
  if (await isPaused(rule.id, entityId)) {
    throw new Error("Entity is paused — remove the pause before replaying")
  }

  // Resolve the WA occurrence before any replay work can throw (including
  // template preparation). Every replay log for that attempt must retain the
  // original occurrence rather than drifting into the current time window.
  const occurrenceKey = rule.action === "SEND_WA"
    ? (log.occurrenceKey ?? automationOccurrenceKey(rule.trigger, log.createdAt))
    : undefined

  try {
    let waOutcome: AutomationWaResult | null = null
    const replayOptions = rule.action === "SEND_WA"
      ? await waReplayOptions({
          log,
          rule,
          occurrenceKey: occurrenceKey!,
          actor,
        })
      : undefined
    switch (rule.trigger) {
      case "LEAD_STALE": {
        const lead = await prisma.lead.findFirst({ where: { id: entityId, tenantId }, select: { firstName: true, lastName: true } })
        if (!lead) throw new Error("Lead not found")
        await actionCreateTask(rule, { type: "lead", id: entityId, ref: `${lead.firstName} ${lead.lastName}` }, tenantId)
        break
      }
      case "DPD_THRESHOLD": {
        const loan = await prisma.loan.findFirst({
          where: { id: entityId, tenantId },
          select: {
            reference: true,
            status: true,
            ncaRegime: true,
            daysInArrears: true,
            arrearsAmount: true,
            outstandingPrincipal: true,
          },
        })
        if (!loan) throw new Error("Loan not found")
        if (rule.action === "ISSUE_SECTION_129") {
          const eligibility = evaluateCollectionsEligibility(loan, "SECTION_129")
          if (!eligibility.eligible) {
            throw new Error(`Section 129 replay blocked: ${eligibility.reason}`)
          }
        }
        if (rule.action === "SEND_WA") {
          waOutcome = await actionSendWa(rule, { type: "loan", id: entityId }, tenantId, replayOptions!)
        }
        else await actionCreateTask(rule, { type: "loan", id: entityId, ref: loan.reference }, tenantId)
        break
      }
      case "PAYMENT_DUE": {
        waOutcome = await actionSendWa(rule, { type: "schedule", id: entityId }, tenantId, replayOptions!)
        break
      }
      case "LOAN_PAID_ON_TIME_N": {
        const loan = await prisma.loan.findFirst({ where: { id: entityId, tenantId }, select: { clientId: true } })
        if (!loan) throw new Error("Loan not found")
        await actionCreateOpportunity(rule, requireClientBorrowerId(loan), tenantId)
        break
      }
      case "LOAN_PAID_IN_FULL": {
        waOutcome = await actionSendWa(rule, { type: "loan", id: entityId }, tenantId, replayOptions!)
        break
      }
      default:
        throw new Error(`No replay handler for trigger: ${rule.trigger}`)
    }
    if (waOutcome) {
      await writeLog({
        ruleId: rule.id,
        tenantId,
        entityType,
        entityId,
        occurrenceKey,
        result: waOutcome.outcome,
        ...(waOutcome.messageId ? { messageId: waOutcome.messageId } : {}),
        dispatchPhase: waOutcome.dispatchPhase,
        ...(waOutcome.detail ? { error: waOutcome.detail } : {}),
      })
      return {
        result: waOutcome.outcome,
        ...(waOutcome.detail ? { error: waOutcome.detail } : {}),
      }
    }
    await writeLog({ ruleId: rule.id, tenantId, entityType, entityId, result: "success" })
    return { result: "success" }
  } catch (err) {
    const msg = String(err)
    await writeLog({
      ruleId: rule.id,
      tenantId,
      entityType,
      entityId,
      ...(occurrenceKey ? { occurrenceKey } : {}),
      ...(rule.action === "SEND_WA" ? { dispatchPhase: "UNKNOWN" as const } : {}),
      result: "failed",
      error: msg,
    })
    return { result: "failed", error: msg }
  }
}
