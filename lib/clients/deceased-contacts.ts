import type { Prisma } from "@prisma/client"

/**
 * Recording a death silences the client's messaging Contact, so no channel,
 * the inbox composer included, messages the estate. `status: BLOCKED` is the
 * suppression flag every send path already honours
 * (lib/messaging/eligibility.ts, channel-availability.ts, inbox/reply-channels.ts).
 *
 * The reason string is the marker for the way back: reversing a death recorded
 * against the wrong client re-opens only the Contacts THIS block closed, never
 * one an operator blocked for fraud or a do-not-contact request.
 */
export const DECEASED_CONTACT_BLOCK_REASON = "DECEASED: client death recorded"

// Structural, so the tenant-scope-extended client's transaction satisfies it too.
type ContactDb = {
  contact: { updateMany: (args: Prisma.ContactUpdateManyArgs) => PromiseLike<{ count: number }> }
}

/** Blocks every not-yet-blocked Contact of the client. Returns how many it closed. */
export async function blockContactsForDeceasedClient(
  db: ContactDb,
  args: { tenantId: string; clientId: string },
): Promise<number> {
  const { count } = await db.contact.updateMany({
    where: { tenantId: args.tenantId, clientId: args.clientId, status: { not: "BLOCKED" } },
    data: { status: "BLOCKED", blockedAt: new Date(), blockedReason: DECEASED_CONTACT_BLOCK_REASON },
  })
  return count
}

/** Re-opens the Contacts a recorded death blocked. Returns how many it re-opened. */
export async function releaseContactsForRevivedClient(
  db: ContactDb,
  args: { tenantId: string; clientId: string },
): Promise<number> {
  const { count } = await db.contact.updateMany({
    where: { tenantId: args.tenantId, clientId: args.clientId, status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON },
    data: { status: "CLIENT", blockedAt: null, blockedReason: null },
  })
  return count
}
