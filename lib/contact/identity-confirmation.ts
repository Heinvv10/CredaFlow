import type { Channel } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"

export const CONFIRMABLE_CHANNELS: readonly Channel[] = ["EMAIL", "WHATSAPP"]

/** The note a confirming staff member leaves: how they know the address is the borrower's. */
export const CONFIRMATION_NOTE_MIN = 10

export type SigningIdentityRefusal = "identity_unconfirmed" | "identity_confirmed_by_witness"

type IdentityReader = Pick<typeof prisma, "contactIdentity">

/**
 * Whether a signing code may go to this destination. A value staff set is unverified until someone else confirms it: without
 * this, one officer could type their own address, take the borrower's code and witness the signature. `witnessUserId` is the
 * staff member driving the signature: the person who confirmed the address does not also witness it. A row with no setter (the
 * borrower's own, or from before this rule) is verified. A destination with no row fails at delivery, as it always has.
 */
export async function signingIdentityRefusal(db: IdentityReader, args: {
  tenantId: string
  channel: Channel
  destination: string
  witnessUserId?: string | null
}): Promise<SigningIdentityRefusal | null> {
  const identity = await db.contactIdentity.findFirst({
    where: { tenantId: args.tenantId, channel: args.channel, value: args.destination },
    select: { setByStaffUserId: true, confirmedAt: true, confirmedByUserId: true },
  })
  if (!identity?.setByStaffUserId) return null
  if (!identity.confirmedAt) return "identity_unconfirmed"
  return args.witnessUserId && identity.confirmedByUserId === args.witnessUserId ? "identity_confirmed_by_witness" : null
}

export type ConfirmResult = { ok: true } | { ok: false; status: 403 | 409; error: string }
type Confirmer =
  | { type: "staff"; id: string; email: string; note: string; ipAddress?: string }
  | { type: "client"; clientId: string; email: string | null; ipAddress?: string }

const NOTHING_TO_CONFIRM = "There is nothing to confirm on this channel."

/**
 * Confirms a staff-set identity: by a different staff member, or by the borrower in their own session. The database refuses the
 * setter too (ContactIdentity_confirmation). Staff cannot make a borrower's confirmation, and the two routes say which this is.
 */
export async function confirmContactIdentity(args: { tenantId: string; clientId: string; channel: Channel; by: Confirmer }): Promise<ConfirmResult> {
  const { tenantId, clientId, channel, by } = args
  return prisma.$transaction(async (tx) => {
    const identity = await tx.contactIdentity.findFirst({
      where: { tenantId, channel, setByStaffUserId: { not: null }, confirmedAt: null, contact: { clientId } },
      select: { id: true, value: true, setByStaffUserId: true },
    })
    if (!identity) return { ok: false as const, status: 409 as const, error: NOTHING_TO_CONFIRM }
    if (by.type === "staff" && identity.setByStaffUserId === by.id) {
      return { ok: false as const, status: 403 as const, error: "You set this address, so someone else must confirm it." }
    }
    const claimed = await tx.contactIdentity.updateMany({
      where: { id: identity.id, tenantId, confirmedAt: null },
      data: { confirmedAt: new Date(), ...(by.type === "staff" ? { confirmedByUserId: by.id } : { confirmedByClientId: by.clientId }) },
    })
    if (claimed.count !== 1) return { ok: false as const, status: 409 as const, error: NOTHING_TO_CONFIRM }
    await logAuditStrict({
      tenantId, ...(by.type === "staff" ? { userId: by.id } : {}), userEmail: by.email ?? undefined, action: AuditAction.CONTACT_IDENTITY_CONFIRMED, entity: "Client", entityId: clientId,
      newValue: { channel, setByStaffUserId: identity.setByStaffUserId, confirmedBy: by.type === "staff" ? { type: "staff", id: by.id, note: by.note } : { type: "client", clientId } },
      ipAddress: by.ipAddress,
    }, tx)
    return { ok: true as const }
  })
}

/** The client's staff-set identities still waiting for confirmation, for the staff card and the borrower's profile. */
export async function unconfirmedIdentities(tenantId: string, clientId: string): Promise<{ channel: "EMAIL" | "WHATSAPP"; display: string }[]> {
  const rows = await prisma.contactIdentity.findMany({
    where: { tenantId, channel: { in: [...CONFIRMABLE_CHANNELS] }, setByStaffUserId: { not: null }, confirmedAt: null, contact: { clientId } },
    select: { channel: true, value: true },
  })
  return rows.map((row) => ({ channel: row.channel as "EMAIL" | "WHATSAPP", display: row.value.replace("@s.whatsapp.net", "") }))
}
