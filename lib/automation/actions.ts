import { prisma } from "@/lib/prisma"
import { WA_TEMPLATES } from "@/lib/whatsapp"
import { findLenderIdentity } from "@/lib/config/identity"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
  type KnownDispatchEvidence,
} from "@/lib/messaging/send"
import { getOrCreateAgentMessageTemplate } from "@/lib/messaging/agent-message-template"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"
import type { CrossSellType, MessageDispatchState, MsgStatus } from "@prisma/client"

type RuleShape = { id: string; name: string; description: string | null; actionConfig: unknown }

function cfg(rule: RuleShape): Record<string, unknown> {
  return (rule.actionConfig ?? {}) as Record<string, unknown>
}

// ── SEND_WA ──────────────────────────────────────────────────────────────────

export type AutomationWaOutcome =
  | "sent"
  | "simulated"
  | "pending"
  | "blocked"
  | "reconciliation_required"
  | "failed"

export type AutomationWaResult = {
  outcome: AutomationWaOutcome
  messageId?: string
  dispatchPhase: AutomationDispatchPhase
  detail?: string
  knownDispatchEvidence?: KnownDispatchEvidence
}

export type AutomationDispatchPhase =
  | "PRE_RESERVATION"
  | "DEFINITELY_REJECTED"
  | "RESERVED_PENDING"
  | "PROVIDER_ACCEPTED"
  | "SIMULATED"
  | "RECONCILIATION_REQUIRED"
  | "UNKNOWN"

export type AutomationWaDispatchOptions = {
  occurrenceKey: string
  rearmDefinitelyRejected?: {
    userId: string
    userEmail: string
    reason: string
  }
}

export function automationWaOutcomeFromMessageStatus(status: MsgStatus): AutomationWaOutcome {
  if (["SENT", "DELIVERED", "READ"].includes(status)) return "sent"
  if (status === "SIMULATED") return "simulated"
  if (["QUEUED", "RETRYING"].includes(status)) return "pending"
  return "failed"
}

export function automationWaDispatchPhaseFromMessage(message: {
  status: MsgStatus
  dispatchState: MessageDispatchState | null
}): AutomationDispatchPhase {
  if (["SENT", "DELIVERED", "READ"].includes(message.status)) return "PROVIDER_ACCEPTED"
  if (message.status === "SIMULATED") return "SIMULATED"
  if (
    message.dispatchState === "ACCEPTED" ||
    message.dispatchState === "SIMULATED" ||
    message.dispatchState === "AMBIGUOUS" ||
    message.dispatchState === "RECONCILED_SENT" ||
    message.dispatchState === "RECONCILED_SIMULATED"
  ) return "RECONCILIATION_REQUIRED"
  if (
    message.dispatchState === "DEFINITELY_REJECTED" &&
    ["FAILED", "FAILED_PERMANENT"].includes(message.status)
  ) return "DEFINITELY_REJECTED"
  if (["QUEUED", "RETRYING"].includes(message.status)) return "RESERVED_PENDING"
  return "UNKNOWN"
}

function preReservationFailure(detail: string): AutomationWaResult {
  return { outcome: "failed", dispatchPhase: "PRE_RESERVATION", detail }
}

export function automationWaIdempotencyKey(args: {
  ruleId: string
  entity: { type: "loan" | "schedule"; id: string }
  templateKey: string
  occurrenceKey: string
}): string {
  if (
    args.occurrenceKey.length < 1 ||
    args.occurrenceKey.length > 128 ||
    /[\u0000-\u001F\u007F]/.test(args.occurrenceKey)
  ) {
    throw new Error("Automation occurrence key must be 1-128 characters without control characters")
  }
  return `automation-wa:${args.ruleId}:${args.entity.type}:${args.entity.id}:${args.templateKey}:${args.occurrenceKey}`
}

export async function sendAutomationWaMessage(args: {
  ruleId: string
  entity: { type: "loan" | "schedule"; id: string }
  templateKey: string
  tenantId: string
  contactId: string
  toValue: string
  message: string
  options: AutomationWaDispatchOptions
}): Promise<AutomationWaResult> {
  let idempotencyKey: string | undefined
  try {
    idempotencyKey = automationWaIdempotencyKey({
      ruleId: args.ruleId,
      entity: args.entity,
      templateKey: args.templateKey,
      occurrenceKey: args.options.occurrenceKey,
    })
    const template = await getOrCreateAgentMessageTemplate(args.tenantId, "WHATSAPP")
    const sentMessage = await sendMessage({
      contactId: args.contactId,
      channel: "WHATSAPP",
      template,
      vars: { body: args.message },
      toValue: args.toValue,
      category: "automation_wa",
      idempotencyKey,
      ...(args.options.rearmDefinitelyRejected
        ? { rearmDefinitelyRejected: args.options.rearmDefinitelyRejected }
        : {}),
    })
    return {
      outcome: automationWaOutcomeFromMessageStatus(sentMessage.status),
      messageId: sentMessage.id,
      dispatchPhase: automationWaDispatchPhaseFromMessage(sentMessage),
    }
  } catch (err) {
    if (err instanceof SendBlockedError) {
      console.error(`[automation] actionSendWa: blocked (${err.reason}) for contact ${args.contactId}, rule ${args.ruleId}`)
      return { outcome: "blocked", dispatchPhase: "PRE_RESERVATION", detail: err.reason }
    }
    if (err instanceof KnownDispatchPersistenceError) {
      console.error(`[automation] actionSendWa: known provider evidence requires reconciliation for message ${err.messageRecord.id}, rule ${args.ruleId}; automatic replay blocked`)
      return {
        outcome: "reconciliation_required",
        messageId: err.messageRecord.id,
        dispatchPhase: "RECONCILIATION_REQUIRED",
        knownDispatchEvidence: knownDispatchEvidenceFromError(err),
      }
    }
    if (err instanceof MessageReconciliationRequiredError) {
      console.error(`[automation] actionSendWa: reconciliation required for message ${err.messageRecord.id}, rule ${args.ruleId}; automatic replay blocked`)
      return {
        outcome: "reconciliation_required",
        messageId: err.messageRecord.id,
        dispatchPhase: "RECONCILIATION_REQUIRED",
      }
    }
    console.error(`[automation] actionSendWa: send failed for contact ${args.contactId}, rule ${args.ruleId}:`, err)
    if (!idempotencyKey) return preReservationFailure("message_preparation_failed")
    try {
      const reserved = await prisma.message.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: args.tenantId,
            idempotencyKey,
          },
        },
        select: { id: true, status: true, dispatchState: true },
      })
      if (!reserved) return preReservationFailure("message_dispatch_failed_before_reservation")
      const dispatchPhase = automationWaDispatchPhaseFromMessage(reserved)
      const outcome = dispatchPhase === "RECONCILIATION_REQUIRED"
        ? "reconciliation_required"
        : automationWaOutcomeFromMessageStatus(reserved.status)
      return {
        outcome,
        messageId: reserved.id,
        dispatchPhase,
        detail: outcome === "failed" ? "message_dispatch_failed" : undefined,
      }
    } catch (lookupError) {
      console.error(`[automation] actionSendWa: could not recover reservation evidence for rule ${args.ruleId}:`, lookupError)
      return { outcome: "failed", dispatchPhase: "UNKNOWN", detail: "message_dispatch_state_unknown" }
    }
  }
}

export async function actionSendWa(
  rule: RuleShape,
  entity: { type: "loan" | "schedule"; id: string },
  tenantId: string,
  options: AutomationWaDispatchOptions,
): Promise<AutomationWaResult> {
  const templateKey = cfg(rule).templateKey as string | undefined
  if (!templateKey || !(templateKey in WA_TEMPLATES)) {
    return preReservationFailure("invalid_template")
  }

  let clientId: string | undefined
  let waPhone: string | undefined
  let message: string | undefined

  if (entity.type === "loan") {
    const loan = await prisma.loan.findUnique({
      where: { id: entity.id },
      select: {
        reference: true,
        arrearsAmount: true,
        client: {
          select: {
            id: true, firstName: true, lastName: true, phone: true, whatsapp: true,
            branch: { select: { tenantId: true } },
          },
        },
      },
    })
    if (!loan || !loan.client.branch || loan.client.branch.tenantId !== tenantId) {
      return preReservationFailure("entity_not_found_or_cross_tenant")
    }
    clientId = loan.client.id
    waPhone = loan.client.whatsapp ?? loan.client.phone
    const name = `${loan.client.firstName} ${loan.client.lastName}`
    // Arrears + default charges outstanding (0 while the flag is off).
    const charges = await chargesOutstandingAt(prisma, { tenantId, loanId: entity.id }, new Date())
    const amount = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format((loan.arrearsAmount + charges) / 100)
    if (templateKey === "payment_overdue_1d") message = WA_TEMPLATES.payment_overdue_1d(name, amount, loan.reference)
    else if (templateKey === "payment_overdue_7d") {
      // Quotes the lender's collections number; never a placeholder.
      const lender = await findLenderIdentity(tenantId)
      if (!lender) return preReservationFailure("lender_identity_not_configured")
      message = WA_TEMPLATES.payment_overdue_7d(name, amount, loan.reference, lender.collectionsPhone)
    }
    else if (templateKey === "loan_paid_in_full") message = WA_TEMPLATES.loan_paid_in_full(name, loan.reference)
  } else if (entity.type === "schedule") {
    const schedule = await prisma.repaymentSchedule.findUnique({
      where: { id: entity.id },
      select: {
        loanId: true,
        dueDate: true,
        totalDue: true,
        totalPaid: true,
        loan: {
          select: {
            reference: true,
            client: {
              select: {
                id: true, firstName: true, lastName: true, phone: true, whatsapp: true,
                branch: { select: { tenantId: true } },
              },
            },
          },
        },
      },
    })
    if (!schedule || !schedule.loan.client.branch || schedule.loan.client.branch.tenantId !== tenantId) {
      return preReservationFailure("entity_not_found_or_cross_tenant")
    }
    clientId = schedule.loan.client.id
    waPhone = schedule.loan.client.whatsapp ?? schedule.loan.client.phone
    const name = `${schedule.loan.client.firstName} ${schedule.loan.client.lastName}`
    // The unpaid instalment + default charges outstanding (0 while the flag is off).
    const charges = await chargesOutstandingAt(prisma, { tenantId, loanId: schedule.loanId }, new Date())
    const amountDue = schedule.totalDue - schedule.totalPaid + charges
    const amount = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(amountDue / 100)
    const dueDate = new Intl.DateTimeFormat("en-ZA").format(new Date(schedule.dueDate))

    if (templateKey === "payment_due_3d") message = WA_TEMPLATES.payment_due_3d(name, amount, dueDate, schedule.loan.reference)
  }

  if (!message || !clientId) return preReservationFailure("message_not_rendered")

  // Rerouted through sendMessage() (previously a direct sendWhatsAppMessage()
  // call with zero persistence). Fail-closed + log loudly rather than
  // silently dropping the send when there's no Contact to hang it on.
  const contact = await prisma.contact.findFirst({ where: { tenantId, clientId } })
  if (!contact) {
    console.error(`[automation] actionSendWa: no Contact for client ${clientId} (rule ${rule.id}) — WhatsApp not sent`)
    return preReservationFailure("contact_missing")
  }
  const toValue = contact.primaryWaJid ?? contact.primaryPhone ?? waPhone
  if (!toValue) {
    console.error(`[automation] actionSendWa: no WhatsApp/phone destination for contact ${contact.id} (rule ${rule.id})`)
    return preReservationFailure("destination_missing")
  }

  return sendAutomationWaMessage({
    ruleId: rule.id,
    entity,
    templateKey,
    tenantId,
    contactId: contact.id,
    toValue,
    message,
    options,
  })
}

// ── CREATE_AGENT_TASK / ISSUE_SECTION_129 / NOTIFY_AGENT ─────────────────────

export async function actionCreateTask(
  rule: RuleShape,
  entity: { type: string; id: string; ref?: string },
  tenantId: string,
): Promise<void> {
  const c = cfg(rule)
  const rawTitle = (c.taskTitle as string | undefined) ?? rule.name
  const title = entity.ref ? rawTitle.replace("{ref}", entity.ref) : rawTitle

  await prisma.agentTask.create({
    data: {
      tenantId,
      type: (c.taskType as string | undefined) ?? "GENERIC",
      title,
      description: rule.description ?? undefined,
      entityType: entity.type,
      entityId: entity.id,
      priority: (c.priority as string | undefined) ?? "MEDIUM",
      createdByRuleId: rule.id,
    },
  })
}

// ── CREATE_OPPORTUNITY ────────────────────────────────────────────────────────

export async function actionCreateOpportunity(
  rule: RuleShape,
  clientId: string,
  tenantId: string,
): Promise<void> {
  const c = cfg(rule)
  const type = ((c.opportunityType as string | undefined) ?? "PERSONAL_LOAN") as CrossSellType
  const description = (c.description as string | undefined) ?? rule.description ?? undefined

  // Avoid duplicates — only create if no pending/contacted opportunity of this type exists for this tenant+client
  const existing = await prisma.crossSellOpportunity.findFirst({
    where: { clientId, tenantId, type, status: { in: ["PENDING", "CONTACTED"] } },
  })
  if (existing) return

  await prisma.crossSellOpportunity.create({
    data: { clientId, tenantId, type, status: "PENDING", notes: description ?? null },
  })
}
