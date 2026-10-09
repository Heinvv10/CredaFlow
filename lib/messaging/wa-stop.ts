import type { Channel, Contact, ConsentPurpose, ConsentStatus, ConsentSource, Direction, MsgStatus, Provider } from "@prisma/client"
import { touchContactInbound, type ContactRecencyTx } from "@/lib/inbox/contact-recency"
import type { WaProvider } from "./wa-provider"
import { lockContactConsentSubject } from "./consent-lock"
import { resolveOpenThreadForContact, type ResolveThreadTx } from "@/lib/inbox/resolve-thread"

export const STOP_REGEX = /^STOP\b/i

type TxLike = {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>
  contactConsent: {
    updateMany: (args: {
      where: { contactId: string; channel: Channel; purpose: ConsentPurpose; effectiveTo: null }
      data: { effectiveTo: Date }
    }) => Promise<{ count: number }>
    create: (args: {
      data: {
        tenantId: string
        contactId: string
        channel: Channel
        purpose: ConsentPurpose
        status: ConsentStatus
        source: ConsentSource
        effectiveFrom: Date
      }
    }) => Promise<{ id: string }>
  }
  conversation: ResolveThreadTx["conversation"] & {
    update: (args: {
      where: { id: string }
      data: { lastInboundAt: Date; lastActivityAt: Date }
    }) => Promise<{ id: string }>
  }
  message: {
    create: (args: {
      data: {
        tenantId: string
        conversationId: string
        channel: Channel
        direction: Direction
        provider: Provider
        providerMessageId: string | null
        fromValue: string
        bodyText: string
        status: MsgStatus
        deliveredAt: Date
      }
    }) => Promise<{ id: string }>
  }
  contact: ContactRecencyTx["contact"]
}

export type WaStopResult = {
  messageId: string
  consentRevokedId: string | null
  conversationId: string
}

/**
 * Pure handler for an inbound WhatsApp message from a KNOWN contact.
 *
 * Caller responsibilities (route handler):
 *   - signature verification + WebhookSignatureFailure persistence on miss
 *   - tenant resolution + `runWithTenant` frame
 *   - Contact lookup via `lookupContactByChannelValue`
 *   - opening the `$transaction` and passing the tx client in here
 *   - emitting the AuditLog rows AFTER this resolves (audit writes are
 *     outside the message tx because `logAudit` swallows errors; we want
 *     a delivered-and-revoked Message to commit even if the audit chain
 *     hiccups, mirroring the pattern in `lib/messaging/send.ts`)
 *
 * Returns the persisted Message id, the new consent row id (or null if
 * the body was not a STOP), and the Conversation id used.
 */
export async function handleWaStopInbound(
  tx: TxLike,
  opts: {
    tenantId: string
    contact: Pick<Contact, "id" | "tenantId">
    fromValue: string
    text: string
    providerMessageId: string | null
    now: Date
    /** Which transport delivered this. REQUIRED, with no default — see
     *  lib/messaging/wa-provider.ts for why. */
    provider: WaProvider
  }
): Promise<WaStopResult> {
  let consentRevokedId: string | null = null

  if (STOP_REGEX.test(opts.text.trimStart())) {
    await lockContactConsentSubject(tx, {
      tenantId: opts.tenantId,
      contactId: opts.contact.id,
    })
    await tx.contactConsent.updateMany({
      where: {
        contactId: opts.contact.id,
        channel: "WHATSAPP",
        purpose: "SERVICE_COMMS",
        effectiveTo: null,
      },
      data: { effectiveTo: opts.now },
    })
    const created = await tx.contactConsent.create({
      data: {
        tenantId: opts.tenantId,
        contactId: opts.contact.id,
        channel: "WHATSAPP",
        purpose: "SERVICE_COMMS",
        status: "REVOKED",
        source: "WA_REPLY_KEYWORD",
        effectiveFrom: opts.now,
      },
    })
    consentRevokedId = created.id
  }

  // One open thread per contact (lib/inbox/resolve-thread.ts). A STOP is an
  // inbound WhatsApp event, so it stamps lastInboundAt either way.
  const resolved = await resolveOpenThreadForContact(tx, {
    tenantId: opts.tenantId,
    contactId: opts.contact.id,
    channel: "WHATSAPP",
    now: opts.now,
    setLastInboundAt: true,
  })
  if (!resolved.created) {
    // lastActivityAt is the inbox queue's sort key and must move with every
    // write to lastInboundAt/lastOutboundAt. opts.now is inbound-receipt
    // time, so it is the newest traffic on this thread.
    await tx.conversation.update({
      where: { id: resolved.id },
      data: { lastInboundAt: opts.now, lastActivityAt: opts.now },
    })
  }
  const conversationId = resolved.id

  const msg = await tx.message.create({
    data: {
      tenantId: opts.tenantId,
      conversationId,
      channel: "WHATSAPP",
      direction: "INBOUND",
      provider: opts.provider,
      providerMessageId: opts.providerMessageId,
      fromValue: opts.fromValue,
      bodyText: opts.text,
      // Inbound is DELIVERED (to us), not QUEUED (to send). Without this the
      // row takes Message.status's QUEUED default and shows up in every
      // "waiting to send" count — the sibling routeInbound writes DELIVERED
      // for the same channel and direction.
      status: "DELIVERED",
      deliveredAt: opts.now,
    },
  })

  // Opens Meta's 24h customer-service window for the sender. Conversation
  // recency above is display-only; lib/whatsapp-cloud.ts reads ONLY this.
  await touchContactInbound(tx, { contactId: opts.contact.id, channel: "WHATSAPP", now: opts.now })

  return { messageId: msg.id, consentRevokedId, conversationId }
}
