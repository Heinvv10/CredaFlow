import { prisma } from "@/lib/prisma"
import { ensureBuiltInRules } from "./built-in-rules"
import { actionCreateTask, actionCreateOpportunity } from "./actions"
import type { AutomationRule } from "@prisma/client"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { automationCooldownMs } from "./occurrence"
import { requireClientBorrowerId } from "@/lib/borrower"

type AutomationLogResult = "success" | "failed" | "skipped"

/**
 * WhatsApp reminders are not an engine action. The borrower reminder crons
 * (app/api/cron/reminders, app/api/cron/payment-reminders) own them; a SEND_WA
 * rule row left over from before is skipped, never run.
 */
export const WHATSAPP_HANDLED_BY_REMINDERS_CRON = "whatsapp_reminders_handled_by_reminders_cron"

const RESULTS_THAT_OCCUPY_COOLDOWN: readonly AutomationLogResult[] = ["success", "skipped"]

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
  result: AutomationLogResult; error?: string
}) {
  await prisma.automationLog.create({ data: opts }).catch((err: unknown) => {
    // Log write failures must not crash the engine, but surface them
    console.error("[automation] Failed to write log:", err)
  })
}

/** Log once per rule (not once per run) that a SEND_WA rule row is being skipped. */
async function skipWhatsAppRule(rule: AutomationRule): Promise<void> {
  const logged = await prisma.automationLog.findFirst({
    where: { ruleId: rule.id, entityType: "rule", entityId: rule.id, error: WHATSAPP_HANDLED_BY_REMINDERS_CRON },
    select: { id: true },
  })
  if (logged) return
  await writeLog({
    ruleId: rule.id, tenantId: rule.tenantId, entityType: "rule", entityId: rule.id,
    result: "skipped", error: WHATSAPP_HANDLED_BY_REMINDERS_CRON,
  })
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

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runAutomationEngine(tenantId: string): Promise<{ ran: number; actions: number; errors: number }> {
  await ensureBuiltInRules(tenantId)

  const rules = await prisma.automationRule.findMany({ where: { tenantId, enabled: true } })
  let ran = 0, actions = 0, errors = 0

  for (const rule of rules) {
    if (rule.action === "SEND_WA") {
      await skipWhatsAppRule(rule)
      continue
    }
    try {
      let count = 0
      switch (rule.trigger) {
        case "LEAD_STALE":          count = await evaluateLeadStale(rule); break
        case "DPD_THRESHOLD":       count = await evaluateDpdThreshold(rule); break
        case "LOAN_PAID_ON_TIME_N": count = await evaluateLoanPaidOnTimeN(rule); break
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

export async function replayAutomationLog(
  logId: string,
  tenantId: string,
): Promise<{ result: AutomationLogResult; error?: string }> {
  const log = await prisma.automationLog.findFirst({
    where: { id: logId, tenantId, rule: { tenantId } },
    include: { rule: true },
  })
  if (!log || log.rule.tenantId !== tenantId || log.rule.tenantId !== log.tenantId) {
    throw new Error("Log entry not found")
  }
  if (log.result !== "failed") throw new Error("Only failed log entries can be replayed")
  if (log.rule.action === "SEND_WA") {
    throw new Error("WhatsApp reminders are no longer sent by the automation engine; they are handled by the reminders cron, so this entry cannot be replayed")
  }

  const { rule, entityType, entityId } = log
  if (await isPaused(rule.id, entityId)) {
    throw new Error("Entity is paused — remove the pause before replaying")
  }

  try {
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
        await actionCreateTask(rule, { type: "loan", id: entityId, ref: loan.reference }, tenantId)
        break
      }
      case "LOAN_PAID_ON_TIME_N": {
        const loan = await prisma.loan.findFirst({ where: { id: entityId, tenantId }, select: { clientId: true } })
        if (!loan) throw new Error("Loan not found")
        await actionCreateOpportunity(rule, requireClientBorrowerId(loan), tenantId)
        break
      }
      default:
        throw new Error(`No replay handler for trigger: ${rule.trigger}`)
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
      result: "failed",
      error: msg,
    })
    return { result: "failed", error: msg }
  }
}
