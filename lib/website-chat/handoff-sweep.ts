import { prisma } from "@/lib/prisma"
import { CHAT_ALERT_EMAIL_CATEGORY, sendChatAlertEmail } from "./alert"
import { expireHandoffIfDue } from "./handoff"
import { HANDOFF_WAIT_MS } from "./mode"
import { releaseIdleChats } from "./staff"

/** A failing alert email is retried, then given up (about an hour at the lease below); the bell item remains. */
const MAX_ALERT_ATTEMPTS = 12
/**
 * A claimed row is left alone this long. It spaces the retries, and it is the lease
 * that stops a run that starts while an earlier one is still sending from sending too.
 */
const ALERT_RETRY_AFTER_MS = 5 * 60 * 1000
/**
 * A hand-off handed off or timed out longer ago than this is never emailed: an address set today
 * must not mail weeks of old chats, nor a run after the cron was down the waits it only now times out.
 */
const ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/**
 * Alert emails per tenant in any 60 minutes, counted from EmailLog (a join deletes the hand-off row, not
 * the mail; failed sends are logged and count too). At the cap a run sends nothing: the rows wait for room, and age out.
 */
const MAX_ALERT_EMAILS_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000
/** Per tenant per run, oldest first; the next minute takes the rest. */
const EXPIRE_BATCH = 200

/** Times out the hand-offs nobody joined in the wait, for a visitor who closed the tab (an open tab's polling does it sooner). */
async function expireDue(tenantId: string, now: Date): Promise<number> {
  const due = await prisma.websiteChatHandoff.findMany({
    where: {
      tenantId, timedOutAt: null, handedOffAt: { lte: new Date(now.getTime() - HANDOFF_WAIT_MS) },
      // The rule expireHandoffIfDue applies, here too: a wait that can never time out (closed,
      // reopened by hand, held by staff) must not fill the batch ahead of one that can.
      conversation: { assigneeId: null, closedAt: null, status: "PENDING_INTERNAL" },
    },
    orderBy: { handedOffAt: "asc" }, take: EXPIRE_BATCH, select: { conversationId: true },
  })
  let expired = 0
  for (const h of due) if (await expireHandoffIfDue({ tenantId, conversationId: h.conversationId, now })) expired++
  return expired
}

/** Emails the tenant's alert address about each timed-out hand-off nobody has joined. No address: nothing is read or written. */
async function emailUnanswered(tenantId: string, now: Date): Promise<{ emailed: number; failed: number }> {
  let emailed = 0
  let failed = 0
  // Once per run. Read-only on purpose: getCommsSettings upserts.
  const to = (await prisma.commsSettings.findUnique({ where: { tenantId }, select: { chatAlertEmail: true } }))?.chatAlertEmail?.trim()
  if (!to) return { emailed, failed }

  // Never claimed, or claimed long enough ago that its send is over. Every claim bumps updatedAt (@updatedAt).
  const free = { OR: [{ alertAttempts: 0 }, { updatedAt: { lt: new Date(now.getTime() - ALERT_RETRY_AFTER_MS) } }] }
  // The email says nobody answered: only for a chat still waiting, not one staff hold, closed, or moved
  // out of the wait (called back and set OPEN, say). A join deletes the row itself.
  const unanswered = { assigneeId: null, closedAt: null, status: "PENDING_INTERNAL" } as const
  const recent = { gte: new Date(now.getTime() - ALERT_MAX_AGE_MS) }
  const eligible = await prisma.websiteChatHandoff.findMany({
    where: {
      tenantId, handedOffAt: recent, timedOutAt: recent, alertEmailSentAt: null, alertAttempts: { lt: MAX_ALERT_ATTEMPTS }, ...free,
      conversation: unanswered,
    },
    orderBy: { timedOutAt: "asc" }, take: MAX_ALERT_EMAILS_PER_HOUR, select: { id: true, conversationId: true, alertAttempts: true },
  })
  // EmailLog has no index: it is counted only in a minute that has something to send.
  if (eligible.length === 0) return { emailed, failed }
  const sentThisHour = await prisma.emailLog.count({ where: { tenantId, category: CHAT_ALERT_EMAIL_CATEGORY, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } } })
  const unsent = eligible.slice(0, Math.max(0, MAX_ALERT_EMAILS_PER_HOUR - sentThisHour))
  for (const h of unsent) {
    // The claim: of two sweepers that read the same row, only one moves the counter, and only it sends.
    // `free` and `unanswered` are repeated so the lease holds at the write, not only at the read
    // above, and a chat staff joined or closed since that read sends nothing.
    const row = { id: h.id, tenantId, alertEmailSentAt: null }
    const claim = await prisma.websiteChatHandoff.updateMany({
      where: { ...row, alertAttempts: h.alertAttempts, ...free, conversation: unanswered }, data: { alertAttempts: h.alertAttempts + 1 },
    })
    if (claim.count !== 1) continue
    const result = await sendChatAlertEmail({ tenantId, conversationId: h.conversationId, to, now })
    if (result !== "sent") {
      failed++
      continue
    }
    // Matches only the row as claimed: a chat handed off again meanwhile has a
    // reset row (store.ts openHandoff), which still needs its own email.
    await prisma.websiteChatHandoff.updateMany({ where: { ...row, alertAttempts: h.alertAttempts + 1 }, data: { alertEmailSentAt: now } })
    emailed++
  }
  return { emailed, failed }
}

/**
 * Once a minute per tenant: times out the hand-offs nobody joined, hands a chat whose
 * visitor has been left waiting by the staff member holding it back to the assistant,
 * and sends the staff email for each hand-off nobody joined.
 */
export async function sweepHandoffs(tenantId: string, now: Date): Promise<{ expired: number; emailed: number; failed: number; released: number }> {
  const expired = await expireDue(tenantId, now)
  const released = await releaseIdleChats(tenantId, now)
  return { expired, released, ...(await emailUnanswered(tenantId, now)) }
}
