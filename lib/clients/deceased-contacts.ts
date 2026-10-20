import type { Prisma } from "@prisma/client"

/**
 * Recording a death silences the client's messaging Contact, so no channel,
 * the inbox composer included, messages the estate by accident. `status:
 * BLOCKED` is the suppression flag every send path already honours
 * (lib/messaging/eligibility.ts, channel-availability.ts, inbox/reply-channels.ts).
 *
 * Writing to the estate or the executor is a deliberate, out-of-band act by
 * staff (a letter, a call, the executor's own address): this block only stops
 * the system and the inbox from messaging the deceased's own number by default.
 * It does not open an estate channel.
 *
 * The reason string is the marker for the way back: reversing a death recorded
 * against the wrong client re-opens only the Contacts THIS block closed, never
 * one an operator blocked for fraud or a do-not-contact request. Only a CLIENT
 * Contact is blocked (a LEAD, STAFF, SPAM or already BLOCKED row is left as it
 * is), and an existing `blockedAt` (a suppression event) is never overwritten.
 */
export const DECEASED_CONTACT_BLOCK_REASON = "DECEASED: client death recorded"

interface ContactRow { id: string; blockedAt: Date | null }

// Structural, so the tenant-scope-extended client's transaction satisfies it too.
type ContactDb = {
  contact: {
    findMany: (args: Prisma.ContactFindManyArgs) => PromiseLike<unknown>
    updateMany: (args: Prisma.ContactUpdateManyArgs) => PromiseLike<{ count: number }>
  }
}

async function contactRows(db: ContactDb, where: Prisma.ContactWhereInput): Promise<ContactRow[]> {
  return await db.contact.findMany({ where, select: { id: true, blockedAt: true } }) as ContactRow[]
}

/** Blocks the client's CLIENT Contacts. Returns how many it closed. */
export async function blockContactsForDeceasedClient(
  db: ContactDb,
  args: { tenantId: string; clientId: string },
): Promise<number> {
  const rows = await contactRows(db, { tenantId: args.tenantId, clientId: args.clientId, status: "CLIENT" })
  let closed = 0
  for (const row of rows) {
    const { count } = await db.contact.updateMany({
      where: { id: row.id, tenantId: args.tenantId, status: "CLIENT" },
      data: { status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON, blockedAt: row.blockedAt ?? new Date() },
    })
    closed += count
  }
  return closed
}

/**
 * Re-opens the Contacts a recorded death blocked, and only those. A `blockedAt`
 * older than the death is a suppression event that predates it and is kept.
 */
export async function releaseContactsForRevivedClient(
  db: ContactDb,
  args: { tenantId: string; clientId: string; deceasedAt: Date },
): Promise<number> {
  const rows = await contactRows(db, {
    tenantId: args.tenantId, clientId: args.clientId, status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON,
  })
  let opened = 0
  for (const row of rows) {
    const ours = row.blockedAt !== null && row.blockedAt >= args.deceasedAt
    const { count } = await db.contact.updateMany({
      where: { id: row.id, tenantId: args.tenantId, status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON },
      data: { status: "CLIENT", blockedReason: null, ...(ours ? { blockedAt: null } : {}) },
    })
    opened += count
  }
  return opened
}
