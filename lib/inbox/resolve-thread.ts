import type { Channel } from "@prisma/client"

/**
 * The ONE way to find-or-create the inbox thread for a contact.
 *
 * The predicate is deliberately channel-free: a contact has at most one open
 * Conversation, and every channel they reach us on lands in it. The DB backs
 * this with the partial unique index Conversation_one_open_per_contact
 * (tenantId, contactId) WHERE closedAt IS NULL.
 *
 * Conversation.channel records only the channel the thread was OPENED on.
 * Message.channel is the authoritative per-message answer. A created thread
 * always stamps lastActivityAt: args.now — the inbox queue sort key, per the
 * migration's COALESCE(..., createdAt) fallback.
 *
 * closedAt (not status) is the predicate: PENDING_CUSTOMER and
 * PENDING_INTERNAL threads are still open and must be reused, or a reply
 * would fork a second thread past the unique index and fail with P2002.
 */
export type ResolveThreadTx = {
  conversation: {
    findFirst: (args: {
      where: { tenantId: string; contactId: string; closedAt: null }
      orderBy: Array<{ lastInboundAt: { sort: "desc"; nulls: "last" } } | { id: "desc" }>
      select: { id: true }
    }) => Promise<{ id: string } | null>
    create: (args: {
      data: {
        tenantId: string
        contactId: string
        channel: Channel
        status: "OPEN"
        subject: string | null
        loanId: string | null
        applicationId: string | null
        lastInboundAt: Date | null
        lastActivityAt: Date
      }
      select: { id: true }
    }) => Promise<{ id: string }>
  }
}

/** The partial unique index in the baseline migration. */
export const ONE_OPEN_PER_CONTACT_INDEX = "Conversation_one_open_per_contact"

/**
 * Is this error the one-open-thread-per-contact unique violation?
 *
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`:
 * callers here are also exercised against mocked Prisma clients, where the
 * rejection is a plain object carrying the same `code`/`meta` shape. Both the
 * structured `meta.target` and the message text are checked because Prisma
 * reports the target as an array on some drivers and folds it into the message
 * on others.
 */
export function isOneOpenPerContactConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { code?: unknown; message?: unknown; meta?: { target?: unknown } }
  if (e.code !== "P2002") return false
  const target = e.meta?.target
  if (typeof target === "string" && target.includes(ONE_OPEN_PER_CONTACT_INDEX)) return true
  if (Array.isArray(target) && target.some((t) => typeof t === "string" && t.includes(ONE_OPEN_PER_CONTACT_INDEX))) return true
  return typeof e.message === "string" && e.message.includes(ONE_OPEN_PER_CONTACT_INDEX)
}

export type ResolveThreadArgs = {
  tenantId: string
  contactId: string
  /** Channel used ONLY when a fresh thread has to be created. */
  channel: Channel
  now: Date
  subject?: string | null
  loanId?: string | null
  applicationId?: string | null
  /** Inbound callers stamp lastInboundAt on the fresh row. */
  setLastInboundAt?: boolean
}

export async function resolveOpenThreadForContact(
  tx: ResolveThreadTx,
  args: ResolveThreadArgs,
): Promise<{ id: string; created: boolean }> {
  const existing = await tx.conversation.findFirst({
    where: { tenantId: args.tenantId, contactId: args.contactId, closedAt: null },
    orderBy: [{ lastInboundAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    select: { id: true },
  })
  if (existing) return { id: existing.id, created: false }

  const data = {
    tenantId: args.tenantId,
    contactId: args.contactId,
    channel: args.channel,
    status: "OPEN" as const,
    subject: args.subject ?? null,
    loanId: args.loanId ?? null,
    applicationId: args.applicationId ?? null,
    lastInboundAt: args.setLastInboundAt === true ? args.now : null,
    lastActivityAt: args.now,
  }

  try {
    const created = await tx.conversation.create({ data, select: { id: true } })
    return { id: created.id, created: true }
  } catch (err) {
    if (!isOneOpenPerContactConflict(err)) throw err
    // A concurrent caller won the race between our findFirst and this create.
    // Their row IS the thread we were about to make, so adopt it.
    //
    // Caveat, deliberate: inside a Postgres transaction the failed INSERT has
    // already aborted the surrounding transaction, so this re-read will itself
    // fail. When it does we rethrow the ORIGINAL P2002 — the caller sees the
    // same error it saw before this catch existed, never a confusing
    // "current transaction is aborted". The recovery therefore only fires
    // where the create ran outside an aborted transaction state.
    const raced = await Promise.resolve(
      tx.conversation.findFirst({
        where: { tenantId: args.tenantId, contactId: args.contactId, closedAt: null },
        orderBy: [{ lastInboundAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        select: { id: true },
      }),
    ).catch(() => null)
    if (raced) return { id: raced.id, created: false }
    throw err
  }
}
