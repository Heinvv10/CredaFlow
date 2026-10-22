/**
 * When a loan with an active tracker completes (docs/asset-finance/SLICE5-FOLLOWUPS.md
 * part T), the database opens a TrackerClosure per device (createTrackerClosures,
 * on any path to COMPLETED). This does the rest, once each, guarded by the
 * closure's own columns (the database records each step once):
 *   - the portal notice: a NotificationLog row per borrower recipient (event
 *     tracking_stopped), shown in the portal with the notice's words;
 *   - the email, through sendMessage only (its consent gate, opt-outs and
 *     kill switches stand; one idempotency key per closure and recipient). The
 *     outcome is recorded as decided once: SENT, SIMULATED, BLOCKED (refused)
 *     or FAILED (the provider failed it). A run claims the step first
 *     (messageClaimedAt), so overlapping runs never send at once; a send still
 *     in flight is left for a later run to replay; an unexpected error fails the run;
 *   - the stored "tracking stopped" letter (a PDF on the closure).
 * The staff task is the closure itself: done when the device is removed
 * (lib/telematics/devices.ts removeTrackerDevice). Recipients are the borrower,
 * or for an entity the people who act for it (./entity-contacts.ts); never a
 * deceased person or unverified dealer-typed contacts.
 */
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { normaliseEmail } from "@/lib/contact/identity"
import { lookupRecipientContact } from "@/lib/contact/recipient"
import { MessageReconciliationRequiredError, sendMessage, SendBlockedError } from "@/lib/messaging/send"
import { MessageDispatchConflictError } from "@/lib/messaging/dispatch-control"
import { messageDeliveryOutcome } from "@/lib/messaging/delivery-outcome"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import { TRUSTED_CONTACT_WHERE } from "@/lib/clients/dealer-contact"
import { getLenderIdentity } from "@/lib/config/identity"
import { deleteFile, saveFile } from "@/lib/storage"
import { legalWordingApproved } from "./documents/nca/legal-wording-approved"
import { renderTrackingStoppedLetter } from "./documents/tracking-stopped-pdf"
import { trackingStoppedEmail, type TrackingStoppedFacts } from "./documents/wording/tracking-stopped"
import { trackingStoppedFactsOf } from "./tracker-closure-facts"
import { entityContactRecipients } from "./entity-contacts"

export const TRACKING_STOPPED_EVENT = "tracking_stopped"
export const TRACKING_STOPPED_EMAIL_KEY = "asset_finance_tracking_stopped_email"

type Recipient = { clientId: string; name: string; email: string; addressLines: string[] }
export type ClosureSend = typeof sendMessage

async function recipientsOf(tenantId: string, loan: { clientId: string | null; entityId: string | null }): Promise<Recipient[]> {
  if (loan.clientId) {
    const client = await prisma.client.findFirst({
      where: { id: loan.clientId, tenantId, deceasedAt: null, ...TRUSTED_CONTACT_WHERE },
      select: { id: true, firstName: true, lastName: true, email: true, addressLine1: true, city: true, province: true, postalCode: true },
    })
    return client ? [{
      clientId: client.id, name: `${client.firstName} ${client.lastName}`, email: client.email,
      addressLines: [client.addressLine1, client.city, client.province, client.postalCode].filter((v): v is string => !!v),
    }] : []
  }
  if (!loan.entityId) return []
  const people = await entityContactRecipients(prisma, tenantId, loan.entityId)
  return people.map((p) => ({ clientId: p.clientId, name: `${p.firstName} ${p.lastName}`, email: p.email, addressLines: [] }))
}

async function logNotice(tenantId: string, closureId: string, loanId: string, recipients: Recipient[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const marked = await tx.trackerClosure.updateMany({ where: { id: closureId, tenantId, noticeLoggedAt: null }, data: { noticeLoggedAt: new Date() } })
    if (marked.count !== 1) return
    for (const r of recipients) {
      await tx.notificationLog.create({ data: { tenantId, loanId, clientId: r.clientId, event: TRACKING_STOPPED_EVENT, channel: "PORTAL", status: "sent" } })
    }
    await logAuditStrict({
      tenantId, action: AuditAction.TRACKER_CLOSURE_NOTICE_LOGGED, entity: "TrackerClosure", entityId: closureId,
      newValue: { loanId, recipients: recipients.map((r) => r.clientId), actor: { type: "system", source: "tracker-closure" } },
    }, tx)
  })
}

/** A claim older than this is a run that died: another may take the email step over. */
export const MESSAGE_CLAIM_STALE_MS = 10 * 60_000

async function sendEmails(tenantId: string, closureId: string, loanId: string, recipients: Recipient[], facts: TrackingStoppedFacts, send: ClosureSend): Promise<void> {
  // One run at a time sends a closure's email: two at once collide inside the send pipeline.
  const claimAt = new Date()
  const claimed = await prisma.trackerClosure.updateMany({
    where: { id: closureId, tenantId, messageDecidedAt: null, OR: [{ messageClaimedAt: null }, { messageClaimedAt: { lt: new Date(claimAt.getTime() - MESSAGE_CLAIM_STALE_MS) } }] },
    data: { messageClaimedAt: claimAt },
  })
  if (claimed.count !== 1) return
  try {
    await sendClaimed(tenantId, closureId, loanId, recipients, facts, send)
  } finally {
    // Undecided (in flight, or failed this run): let the next run take the step at once. Only this run's own claim
    // (one that went stale may have been taken over); a decided step keeps its claim.
    await prisma.trackerClosure.updateMany({ where: { id: closureId, tenantId, messageDecidedAt: null, messageClaimedAt: claimAt }, data: { messageClaimedAt: null } })
  }
}

async function sendClaimed(tenantId: string, closureId: string, loanId: string, recipients: Recipient[], facts: TrackingStoppedFacts, send: ClosureSend): Promise<void> {
  const template = await prisma.messageTemplate.findFirst({ where: { tenantId, key: TRACKING_STOPPED_EMAIL_KEY, channel: "EMAIL", active: true } })
  const legs: { outcome: "SENT" | "SIMULATED" | "BLOCKED" | "FAILED"; note: string; messageId?: string }[] = []
  // The lender's email switch (EmailConfig.active, the channel's only one): off, nothing is sent and that is the decision.
  const email = await prisma.emailConfig.findUnique({ where: { tenantId }, select: { active: true } })
  if (!email?.active) legs.push({ outcome: "BLOCKED", note: "The lender's email is not set up or is switched off" })
  else if (!template) legs.push({ outcome: "BLOCKED", note: "The tracking-stopped email template is missing" })
  if (recipients.length === 0) legs.push({ outcome: "BLOCKED", note: "No recipient with trusted contact details" })
  const words = trackingStoppedEmail(facts)
  // A send another run is still dispatching (the same idempotency key) is not decided here: the next run replays its outcome.
  let undecided = false
  for (const r of recipients) {
    if (!template || !email?.active) break
    const to = normaliseEmail(r.email)
    const found = to ? await lookupRecipientContact(prisma, { tenantId, channel: "EMAIL", value: to, ownerClientId: r.clientId }) : null
    if (!to || !found?.ok) {
      legs.push({ outcome: "BLOCKED", note: `${r.clientId}: no deliverable email Contact` })
      continue
    }
    try {
      const message = await send({
        contactId: found.contact.id, channel: "EMAIL", template, toValue: to, toName: r.name, vars: words, loanId,
        category: TRACKING_STOPPED_EVENT, idempotencyKey: `tracking-stopped:${closureId}:${r.clientId}`,
      })
      const delivered = messageDeliveryOutcome(message.status)
      if (delivered === "pending") {
        undecided = true
        continue
      }
      legs.push({ outcome: delivered === "simulated" ? "SIMULATED" : delivered === "not_sent" ? "FAILED" : "SENT", note: `${r.clientId}: ${message.status}`, messageId: message.id })
    } catch (error) {
      if (error instanceof MessageDispatchConflictError || error instanceof MessageReconciliationRequiredError) {
        undecided = true
        continue
      }
      // Anything but a refusal is not a decision: the closure fails this run and the next one tries again.
      if (!(error instanceof SendBlockedError)) throw error
      legs.push({ outcome: "BLOCKED", note: `${r.clientId}: ${error.reason}` })
    }
  }
  if (undecided) return
  // The weakest leg decides: one BLOCKED or FAILED recipient is not "sent".
  const order = ["FAILED", "BLOCKED", "SIMULATED", "SENT"] as const
  const outcome = order.find((o) => legs.some((l) => l.outcome === o)) ?? "BLOCKED"
  await prisma.$transaction(async (tx) => {
    const marked = await tx.trackerClosure.updateMany({
      where: { id: closureId, tenantId, messageDecidedAt: null },
      data: { messageOutcome: outcome, messageNote: legs.map((l) => l.note).join("; ").slice(0, 1000), messageId: legs.find((l) => l.messageId)?.messageId ?? null, messageDecidedAt: new Date() },
    })
    if (marked.count !== 1) return
    await logAuditStrict({
      tenantId, action: AuditAction.TRACKER_CLOSURE_MESSAGE_DECIDED, entity: "TrackerClosure", entityId: closureId,
      newValue: { loanId, outcome, legs: legs.length, actor: { type: "system", source: "tracker-closure" } },
    }, tx)
  })
}

async function storeLetter(tenantId: string, closureId: string, loanId: string, recipient: Recipient | undefined, borrower: string, facts: TrackingStoppedFacts): Promise<void> {
  const lender = await getLenderIdentity(tenantId)
  const bytes = await renderTrackingStoppedLetter({
    // Only an approved lender's closures get this far (processTrackerClosures).
    ...facts, documentDate: new Date(), legalWordingApproved: true,
    lender: { legalName: lender.legalName, ncrNumber: lender.ncrNumber, registeredOfficeLines: lender.registeredOfficeLines },
    recipient: { name: borrower, addressLines: recipient?.addressLines ?? [] },
  })
  const { storagePath } = await saveFile(bytes, "application/pdf")
  const stored = await prisma.$transaction(async (tx) => {
    const marked = await tx.trackerClosure.updateMany({
      where: { id: closureId, tenantId, letterGeneratedAt: null },
      data: { letterStoragePath: storagePath, letterSha256: createHash("sha256").update(bytes).digest("hex"), letterGeneratedAt: new Date() },
    })
    if (marked.count !== 1) return false
    await logAuditStrict({
      tenantId, action: AuditAction.TRACKER_CLOSURE_LETTER_STORED, entity: "TrackerClosure", entityId: closureId,
      newValue: { loanId, bytes: bytes.length, actor: { type: "system", source: "tracker-closure" } },
    }, tx)
    return true
  })
  if (!stored) await deleteFile(storagePath)
}

/**
 * A lender that predates the template gets it here (idempotent: an existing row with the key, or the same event and
 * channel, is left alone), as the dunning templates are (lib/collections/dunning-templates.ts).
 */
async function ensureTrackingStoppedTemplate(tenantId: string): Promise<void> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { brandName: true, legalName: true } })
  const lender = config?.brandName?.trim() || config?.legalName?.trim() || "The lender"
  await seedDefaultMessageTemplates(prisma, tenantId, lender, { only: (t) => t.key === TRACKING_STOPPED_EMAIL_KEY })
}

/**
 * Every open step of one lender's closures, each once. A failing closure is counted and left for the next run.
 * Nothing is told to a borrower until the lender has approved the wording (TenantConfig.assetFinanceLegalWordingApproved):
 * until then the closures wait, counted as held, and the staff task shows why.
 */
export async function processTrackerClosures(tenantId: string, send: ClosureSend = sendMessage): Promise<{ closures: number; failed: number; held: number }> {
  const pending = await prisma.trackerClosure.findMany({
    // A loan reopened since it completed is not told anything; its closure waits for it to complete again.
    where: { tenantId, loan: { status: "COMPLETED" }, OR: [{ noticeLoggedAt: null }, { messageDecidedAt: null }, { letterGeneratedAt: null }] },
    orderBy: { createdAt: "asc" }, take: 200,
    select: {
      id: true, loanId: true, closedAt: true, noticeLoggedAt: true, messageDecidedAt: true, letterGeneratedAt: true,
      loan: { select: { reference: true, clientId: true, entityId: true, entity: { select: { legalName: true } }, asset: { select: { make: true, model: true, serialNumber: true } } } },
    },
  })
  let failed = 0
  if (pending.length === 0) return { closures: 0, failed, held: 0 }
  if (!(await legalWordingApproved(prisma, tenantId))) return { closures: 0, failed, held: pending.length }
  // Fail closed and count every closure failed when the lender's identity is not configured (nothing is told without it).
  let lender: Awaited<ReturnType<typeof getLenderIdentity>>
  try {
    lender = await getLenderIdentity(tenantId)
  } catch (error) {
    console.error("[tracker-closure] lender identity missing", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    return { closures: pending.length, failed: pending.length, held: 0 }
  }
  await ensureTrackingStoppedTemplate(tenantId)
  for (const closure of pending) {
    try {
      const recipients = await recipientsOf(tenantId, closure.loan)
      const facts = await trackingStoppedFactsOf(tenantId, lender.legalName, closure)
      if (!closure.noticeLoggedAt) await logNotice(tenantId, closure.id, closure.loanId, recipients)
      if (!closure.messageDecidedAt) await sendEmails(tenantId, closure.id, closure.loanId, recipients, facts, send)
      if (!closure.letterGeneratedAt) {
        const borrower = closure.loan.entity?.legalName ?? recipients[0]?.name ?? "The borrower"
        await storeLetter(tenantId, closure.id, closure.loanId, closure.loan.entity ? undefined : recipients[0], borrower, facts)
      }
    } catch (error) {
      failed++
      console.error("[tracker-closure] closure failed", { tenantId, closureId: closure.id, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  return { closures: pending.length, failed, held: 0 }
}
