// Persist inbound customer email into the domain. Two paths:
//  - recordEmailReply: the loan-note continuity path (EmailLog SENT→REPLIED +
//    a LoanNote), keyed off the X-Lms-Ref header the outbound send stamps.
//  - recordInboundEmailMessage: the comms-hub threading path (a Message on the
//    right Conversation, sender-verified).
// Split out of inbound-poll.ts so the poll transports stay a thin I/O layer.
//
// All writes use explicit `where/data: { tenantId }`, so this is safe to call
// under `withoutTenantScope` from the cross-tenant cron.

import { prisma } from "@/lib/prisma"
import { normaliseEmail, lookupContactByChannelValue } from "@/lib/contact/identity"
import { Prisma } from "@prisma/client"
import type { InboundEmailInput } from "./parse-inbound"
import { resolveOpenThreadForContact } from "@/lib/inbox/resolve-thread"

// Re-exported so importers (and tests) can source the input type from the
// record layer alongside the functions that consume it.
export type { InboundEmailInput }

/**
 * Record a single email reply against its loan. Returns true iff a LoanNote was
 * created (i.e. this was the first time the reply was seen).
 *
 * - Verifies the loan belongs to `tenantId` before any write (a header-supplied
 *   loan id is untrusted input).
 * - Idempotent: only the SENT→REPLIED transition drops a note, so the cron's
 *   7-day / top-50 reprocessing window can't spawn duplicate notes.
 * - Atomic: the status flip + note are one transaction, so a mid-flight failure
 *   can't leave the EmailLog REPLIED with the note lost forever (which the
 *   idempotency gate would otherwise make unrecoverable).
 */
export async function recordEmailReply(
  tenantId: string,
  args: { loanId: string; subject: string; fromAddress: string; repliedAt: Date },
): Promise<boolean> {
  const loan = await prisma.loan.findFirst({ where: { id: args.loanId, tenantId }, select: { id: true } })
  if (!loan) return false

  return prisma.$transaction(async (tx) => {
    const upd = await tx.emailLog.updateMany({
      where: { tenantId, referenceId: args.loanId, status: "SENT" },
      data: { status: "REPLIED", repliedAt: args.repliedAt },
    })
    if (upd.count === 0) return false
    await tx.loanNote.create({
      data: {
        tenantId,
        loanId: args.loanId,
        type: "email",
        note: `📧 Client replied via email: "${args.subject}" from ${args.fromAddress}`,
        createdBy: "system",
      },
    })
    return true
  })
}

export type RecordInboundResult = { created: boolean; messageId?: string; conversationId?: string }

// Derived from the extended `prisma` client's own $transaction signature
// (not the bare `Prisma.TransactionClient`) — `prisma` here is wrapped by the
// tenant-scope `$extends()`, and the bare type rejects that extended client.
// Same pattern as lib/messaging/retry.ts:TxClient.
type InboundTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * Resolve which Conversation an inbound email belongs to.
 * 1. Identify the sender: the Contact owning this from-address (EMAIL identity,
 *    else primaryEmail). Header From is untrusted, so this is our only anchor.
 * 2. Thread match: a prior OUTBOUND email Message cited by In-Reply-To /
 *    References — honoured ONLY when it belongs to the sender's own Contact.
 *    Without that check, a forged In-Reply-To/References citing a leaked
 *    outbound Message-ID could graft a stranger's email onto another client's
 *    thread (POPIA data-integrity / spoofing).
 * 3. Contact fallback: the sender's non-closed email Conversation, else a new one.
 * Returns null for an unknown sender (no owning Contact) — caller skips, so an
 * unverified address is never attached to any thread (POPIA-safe).
 */
export async function resolveInboundEmailConversationTx(
  tx: InboundTx,
  tenantId: string,
  opts: { inReplyTo: string | null; references: string[]; fromAddress: string },
): Promise<{ conversationId: string } | null> {
  const value = normaliseEmail(opts.fromAddress)
  let contact = await lookupContactByChannelValue(tx, { tenantId, channel: "EMAIL", value })
  if (!contact) {
    // Secondary match: a Contact carrying this as primaryEmail but without a
    // ContactIdentity EMAIL row yet.
    contact = await tx.contact.findFirst({ where: { tenantId, primaryEmail: value } })
  }
  // Unknown sender: no verifiable owner, so never thread — not even on a cited
  // Message-ID (that citation is attacker-controllable).
  if (!contact) return null

  const candidates = [opts.inReplyTo, ...opts.references].filter((v): v is string => !!v)
  if (candidates.length > 0) {
    const prior = await tx.message.findFirst({
      where: { tenantId, channel: "EMAIL", direction: "OUTBOUND", providerMessageId: { in: candidates } },
      orderBy: { createdAt: "desc" },
      select: { conversationId: true, conversation: { select: { contactId: true } } },
    })
    // Only honour the thread match when the cited conversation belongs to the
    // sender we just verified — otherwise fall through to sender-based matching.
    if (prior && prior.conversation?.contactId === contact.id) {
      return { conversationId: prior.conversationId }
    }
  }

  // One open thread per contact (lib/inbox/resolve-thread.ts). An inbound
  // email lands in the same thread as the contact's WhatsApp; Message.channel
  // records that this one arrived by email.
  const resolved = await resolveOpenThreadForContact(tx, {
    tenantId,
    contactId: contact.id,
    channel: "EMAIL",
    now: new Date(),
  })
  return { conversationId: resolved.id }
}

/**
 * Record an inbound email as a Message threaded into its Conversation.
 * Idempotent on (provider, providerMessageId). Returns created:false when the
 * message was already recorded, or when the sender can't be threaded/matched.
 */
export async function recordInboundEmailMessage(
  tenantId: string,
  input: InboundEmailInput,
): Promise<RecordInboundResult> {
  if (!input.providerMessageId) return { created: false }

  return prisma.$transaction(async (tx) => {
    const seen = await tx.message.findFirst({
      where: { tenantId, provider: input.provider, providerMessageId: input.providerMessageId },
      select: { id: true },
    })
    if (seen) return { created: false }

    const conv = await resolveInboundEmailConversationTx(tx, tenantId, {
      inReplyTo: input.inReplyTo,
      references: input.references,
      fromAddress: input.fromAddress,
    })
    if (!conv) return { created: false }

    let message: { id: string }
    try {
      message = await tx.message.create({
        data: {
          tenantId,
          conversationId: conv.conversationId,
          channel: "EMAIL",
          direction: "INBOUND",
          provider: input.provider,
          providerMessageId: input.providerMessageId,
          fromValue: normaliseEmail(input.fromAddress),
          toValue: input.toAddress,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          // Inbound mail has already arrived — mark DELIVERED (not the QUEUED
          // default, which means "awaiting outbound dispatch"). Mirrors the
          // inbound site in lib/inbox/routing.ts.
          status: "DELIVERED",
          deliveredAt: input.receivedAt,
          createdAt: input.receivedAt,
        },
        select: { id: true },
      })
    } catch (e) {
      // Unique (provider, providerMessageId) race — another poll won. Idempotent.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return { created: false }
      }
      throw e
    }

    await tx.conversation.update({
      where: { id: conv.conversationId, tenantId },
      data: { lastInboundAt: input.receivedAt, status: "OPEN" },
    })

    // lastActivityAt is the inbox queue's sort key and must move with every
    // write to lastInboundAt/lastOutboundAt. Guarded rather than set outright:
    // receivedAt is the mail's own arrival time and IMAP polling lags it, so an
    // outbound accepted in between can legitimately be newer. Writing it
    // unconditionally would drag the thread backwards in the queue.
    await tx.conversation.updateMany({
      where: {
        id: conv.conversationId,
        tenantId,
        OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: input.receivedAt } }],
      },
      data: { lastActivityAt: input.receivedAt },
    })

    return { created: true, messageId: message.id, conversationId: conv.conversationId }
  })
}
