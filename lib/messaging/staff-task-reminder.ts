import { Prisma, type Channel, type Message, type MessageTemplate } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { normaliseEmail, toWaJid } from "@/lib/contact/identity"
import { sanitizeNotificationLogError } from "@/lib/notifications"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  sendMessage,
  type KnownDispatchOutcome,
} from "./send"
import { requiresMessageReconciliation } from "./reconciliation"

export type StaffTaskReminderChannel = "EMAIL" | "WHATSAPP"
export type StaffTaskReminderOutcome =
  | "sent"
  | "simulated"
  | "pending"
  | "reconciliation_required"
  | "failed"

export type StaffTaskReminderResult = {
  outcome: StaffTaskReminderOutcome
  recorded: boolean
  messageId: string | null
  error?: string
  knownDispatchEvidence?: StaffTaskReminderKnownDispatchEvidence
}

export type StaffTaskReminderKnownDispatchEvidence = {
  outcome: KnownDispatchOutcome
  providerMessageId?: string
  evidenceReference?: string
  simulationReceiptId?: string
}

const TEMPLATE_KEY: Record<StaffTaskReminderChannel, string> = {
  EMAIL: "lead_task_reminder_email",
  WHATSAPP: "lead_task_reminder_whatsapp",
}

function reminderOutcome(message: Message): StaffTaskReminderOutcome {
  if (requiresMessageReconciliation(message)) return "reconciliation_required"
  if (["SENT", "DELIVERED", "READ"].includes(message.status)) return "sent"
  if (message.status === "SIMULATED") return "simulated"
  if (["QUEUED", "RETRYING"].includes(message.status)) return "pending"
  return "failed"
}

function auditAction(outcome: StaffTaskReminderOutcome): string {
  switch (outcome) {
    case "sent": return AuditAction.LEAD_TASK_REMINDER_SENT
    case "simulated": return AuditAction.LEAD_TASK_REMINDER_SIMULATED
    case "pending": return AuditAction.LEAD_TASK_REMINDER_PENDING
    case "reconciliation_required": return AuditAction.LEAD_TASK_REMINDER_RECONCILIATION_REQUIRED
    case "failed": return AuditAction.LEAD_TASK_REMINDER_FAILED
  }
}

function projectionStatus(outcome: StaffTaskReminderOutcome): string {
  switch (outcome) {
    case "sent": return "sent"
    case "simulated": return "simulated"
    case "pending": return "pending"
    case "reconciliation_required": return "reconciliation_required"
    case "failed": return "failed"
  }
}

function destination(channel: StaffTaskReminderChannel, value: string): string {
  const normalised = channel === "EMAIL" ? normaliseEmail(value) : toWaJid(value)
  if (!normalised) throw new Error(`Invalid ${channel.toLowerCase()} staff reminder destination`)
  return normalised
}

/**
 * Resolve one staff member to a deliberately STAFF-classified Contact.
 *
 * The advisory lock serialises first use of a channel identity. An identity
 * already owned by a customer/lead is rejected rather than silently threading
 * internal work reminders into that person's conversation history.
 */
async function resolveStaffContact(args: {
  tenantId: string
  userId: string
  name: string | null
  channel: StaffTaskReminderChannel
  toValue: string
}): Promise<{ contactId: string; toValue: string }> {
  const toValue = destination(args.channel, args.toValue)
  return prisma.$transaction(async (tx) => {
    const firstSeenContext = `staff_task_reminder:${args.userId}`
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      `staff-reminder-contact:${args.tenantId}:${args.userId}`,
    )
    await tx.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      `staff-reminder:${args.tenantId}:${args.channel}:${toValue}`,
    )
    const existing = await tx.contactIdentity.findFirst({
      where: { tenantId: args.tenantId, channel: args.channel, value: toValue },
      include: { contact: true },
    })
    if (existing) {
      if (existing.contact.status !== "STAFF") {
        throw new Error("Staff reminder destination is already owned by a non-staff contact")
      }
      if (existing.contact.firstSeenContext !== firstSeenContext) {
        throw new Error("Staff reminder destination is already owned by a different staff user")
      }
      return { contactId: existing.contactId, toValue }
    }

    const priorStaffContact = await tx.contact.findFirst({
      where: { tenantId: args.tenantId, status: "STAFF", firstSeenContext },
    })
    const contact = priorStaffContact
      ? await tx.contact.update({
          where: { id: priorStaffContact.id, tenantId: args.tenantId },
          data: {
            firstName: args.name?.trim() || priorStaffContact.firstName,
            ...(args.channel === "EMAIL" ? { primaryEmail: toValue } : { primaryWaJid: toValue }),
          },
        })
      : await tx.contact.create({
          data: {
            tenantId: args.tenantId,
            firstName: args.name?.trim() || null,
            primaryEmail: args.channel === "EMAIL" ? toValue : null,
            primaryWaJid: args.channel === "WHATSAPP" ? toValue : null,
            status: "STAFF",
            firstSeenChannel: args.channel,
            firstSeenContext,
          },
        })
    await tx.contactIdentity.create({
      data: {
        tenantId: args.tenantId,
        contactId: contact.id,
        channel: args.channel,
        value: toValue,
        source: "MANUAL",
        verified: true,
      },
    })
    return { contactId: contact.id, toValue }
  }, { isolationLevel: "Serializable" })
}

async function getOrCreateTemplate(
  tenantId: string,
  channel: StaffTaskReminderChannel,
): Promise<MessageTemplate> {
  const key = TEMPLATE_KEY[channel]
  const isEmail = channel === "EMAIL"
  return prisma.messageTemplate.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: {
      subject: isEmail ? "{{subject}}" : null,
      body: "{{body}}",
      bodyTemplate: isEmail ? "{{bodyHtml}}" : null,
      active: true,
      category: "TRANSACTIONAL",
      product: "GENERAL",
      statutoryOverride: false,
    },
    create: {
      tenantId,
      event: key,
      key,
      channel: channel as Channel,
      subject: isEmail ? "{{subject}}" : null,
      body: "{{body}}",
      bodyTemplate: isEmail ? "{{bodyHtml}}" : null,
      active: true,
      category: "TRANSACTIONAL",
      product: "GENERAL",
      statutoryOverride: false,
      language: "en",
    },
  })
}

async function recordProjection(args: {
  tenantId: string
  taskId: string
  leadId: string
  dueAt: Date
  recipientUserId: string
  recipientEmail: string
  channel: StaffTaskReminderChannel
  outcome: StaffTaskReminderOutcome
  messageId: string | null
  dispatchState: Message["dispatchState"] | null
  knownDispatchEvidence?: StaffTaskReminderKnownDispatchEvidence
  error?: string
}): Promise<boolean> {
  const error = sanitizeNotificationLogError(args.error) ?? null
  const occurrenceId = `lead-task-reminder:${args.tenantId}:${args.taskId}:${args.dueAt.toISOString()}:${args.channel}`
  try {
    await prisma.$transaction(async (tx) => {
      const projection = {
        tenantId: args.tenantId,
        event: "lead_task_reminder",
        channel: args.channel.toLowerCase(),
        status: projectionStatus(args.outcome),
        error,
        messageId: args.messageId,
      }
      await tx.notificationLog.upsert({
        where: { id: occurrenceId, tenantId: args.tenantId },
        update: projection,
        create: {
          id: occurrenceId,
          ...projection,
        },
      })
      await tx.auditLog.createMany({
        data: [{
          id: `${occurrenceId}:${args.outcome}`,
          tenantId: args.tenantId,
          userId: null,
          userEmail: null,
          action: auditAction(args.outcome),
          entity: "AgentTask",
          entityId: args.taskId,
          newValue: {
            recipientUserId: args.recipientUserId,
            recipientEmail: args.recipientEmail,
            channel: args.channel,
            status: projectionStatus(args.outcome),
            outcome: args.outcome,
            leadId: args.leadId,
            dueAt: args.dueAt.toISOString(),
            messageId: args.messageId,
            dispatchState: args.dispatchState,
            knownDispatchEvidence: args.knownDispatchEvidence ?? null,
            error,
          } as Prisma.InputJsonValue,
        }],
        skipDuplicates: true,
      })
    })
    return true
  } catch (error) {
    console.error(`[lead-task-reminder] Accountability transaction failed for ${args.taskId}:`, error)
    return false
  }
}

/**
 * Dispatch one staff task reminder through the same durable Message boundary
 * as every other external communication, then atomically write its
 * NotificationLog projection and task-specific audit event.
 */
export async function sendStaffTaskReminder(args: {
  tenantId: string
  taskId: string
  leadId: string
  dueAt: Date
  recipientUserId: string
  recipientName: string | null
  recipientEmail: string
  channel: StaffTaskReminderChannel
  toValue: string
  subject?: string
  text: string
  html?: string
}): Promise<StaffTaskReminderResult> {
  const idempotencyKey = `lead-task-reminder:${args.taskId}:${args.dueAt.toISOString()}:${args.channel}`
  let message: Message | null = null
  let caught: unknown
  let forcedOutcome: StaffTaskReminderOutcome | null = null
  let knownDispatchEvidence: StaffTaskReminderKnownDispatchEvidence | undefined

  try {
    const [recipient, template] = await Promise.all([
      resolveStaffContact({
        tenantId: args.tenantId,
        userId: args.recipientUserId,
        name: args.recipientName,
        channel: args.channel,
        toValue: args.toValue,
      }),
      getOrCreateTemplate(args.tenantId, args.channel),
    ])
    message = await sendMessage({
      contactId: recipient.contactId,
      channel: args.channel,
      template,
      vars: {
        body: args.text,
        subject: args.subject ?? "",
        bodyHtml: args.html ?? args.text,
      },
      toValue: recipient.toValue,
      category: "lead_task_reminder",
      idempotencyKey,
    })
  } catch (error) {
    caught = error
    if (error instanceof KnownDispatchPersistenceError) {
      message = error.messageRecord
      forcedOutcome = "reconciliation_required"
      knownDispatchEvidence = {
        outcome: error.outcome,
        ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
        ...(error.evidenceReference ? { evidenceReference: error.evidenceReference } : {}),
        ...(error.simulationReceiptId ? { simulationReceiptId: error.simulationReceiptId } : {}),
      }
    } else if (error instanceof MessageReconciliationRequiredError) {
      message = error.messageRecord
    } else {
      // A provider-side persistence exception can still leave the durable
      // reservation behind. Recover it by the exact business key before
      // deciding whether this was a preparation failure.
      message = await prisma.message.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: args.tenantId, idempotencyKey } },
      })
    }
  }

  const outcome = forcedOutcome ?? (message ? reminderOutcome(message) : "failed")
  const rawError = caught instanceof KnownDispatchPersistenceError
    ? caught.message
    : message?.errorMessage ?? (caught instanceof Error ? caught.message : caught ? String(caught) : undefined)
  const recorded = await recordProjection({
    tenantId: args.tenantId,
    taskId: args.taskId,
    leadId: args.leadId,
    dueAt: args.dueAt,
    recipientUserId: args.recipientUserId,
    recipientEmail: args.recipientEmail,
    channel: args.channel,
    outcome,
    messageId: message?.id ?? null,
    dispatchState: message?.dispatchState ?? null,
    knownDispatchEvidence,
    error: rawError,
  })

  return {
    outcome,
    recorded,
    messageId: message?.id ?? null,
    ...(rawError ? { error: rawError } : {}),
    ...(knownDispatchEvidence ? { knownDispatchEvidence } : {}),
  }
}
