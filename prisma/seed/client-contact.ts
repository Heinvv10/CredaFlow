import { prisma } from "@/lib/prisma"
import { provisionContactForClient } from "@/lib/contact/provision"

/**
 * The seeded client's Contact and channel identities, as the app's client create
 * provisions them (lib/contact/provision.ts). Every outbound message resolves its
 * recipient through their own Contact (lib/contact/recipient.ts): without one, every
 * reminder and notice to the client fails "No Contact row". Idempotent: a rerun, or
 * a client created by an earlier seed, gets what it lacks and nothing twice.
 */
export async function ensureClientContact(tenantId: string, clientId: string): Promise<void> {
  const client = await prisma.client.findFirstOrThrow({
    where: { id: clientId, tenantId },
    select: { firstName: true, lastName: true, email: true, phone: true, whatsapp: true },
  })
  await prisma.$transaction((tx) => provisionContactForClient(tx, { tenantId, clientId, ...client, source: "MANUAL" }))
}
