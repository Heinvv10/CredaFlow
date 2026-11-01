import type { Channel } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { maskEmail, maskPhone } from "@/lib/signing-otp/code"

export const CONFIRMABLE_CHANNELS: readonly Channel[] = ["EMAIL", "WHATSAPP"]

/** The note a confirming staff member leaves: how they know the address is the borrower's. */
export const CONFIRMATION_NOTE_MIN = 10

/**
 * For the client lookups of forgot-password, reset and portal activation: a client with a staff-set address nobody has confirmed
 * is not found. Staff who can type an address cannot recover the borrower's login through it. In the query, so a match costs
 * no extra read and the answer stays the same for an account that does not exist.
 */
export const NO_UNCONFIRMED_IDENTITY_WHERE = {
  NOT: { contact: { identities: { some: { setByStaffUserId: { not: null }, confirmedAt: null } } } },
} as const

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

const NOTHING_TO_CONFIRM = "That address is not waiting for confirmation: it changed, or someone already confirmed it. Refresh and review it."

/**
 * Confirms a staff-set identity: only a second staff member can. A borrower cannot, because a session reached by recovering the
 * login through that very address proves nothing. It names the row the confirmer reviewed: a value that changed under them has
 * another id, so it is not confirmed unseen. The database refuses the setter too (ContactIdentity_confirmation).
 */
export async function confirmContactIdentity(args: {
  tenantId: string
  clientId: string
  identityId: string
  by: { id: string; email: string; note: string; ipAddress?: string }
}): Promise<ConfirmResult> {
  const { tenantId, clientId, identityId, by } = args
  return prisma.$transaction(async (tx) => {
    const identity = await tx.contactIdentity.findFirst({
      where: { id: identityId, tenantId, setByStaffUserId: { not: null }, confirmedAt: null, contact: { clientId } },
      select: { id: true, channel: true, value: true, setByStaffUserId: true },
    })
    if (!identity) return { ok: false as const, status: 409 as const, error: NOTHING_TO_CONFIRM }
    if (identity.setByStaffUserId === by.id) {
      return { ok: false as const, status: 403 as const, error: "You set this address, so someone else must confirm it." }
    }
    const claimed = await tx.contactIdentity.updateMany({
      where: { id: identityId, tenantId, confirmedAt: null },
      data: { confirmedAt: new Date(), confirmedByUserId: by.id },
    })
    if (claimed.count !== 1) return { ok: false as const, status: 409 as const, error: NOTHING_TO_CONFIRM }
    await logAuditStrict({
      tenantId, userId: by.id, userEmail: by.email, action: AuditAction.CONTACT_IDENTITY_CONFIRMED, entity: "Client", entityId: clientId,
      newValue: {
        identityId: identity.id, channel: identity.channel, maskedValue: identity.channel === "EMAIL" ? maskEmail(identity.value) : maskPhone(identity.value),
        setByStaffUserId: identity.setByStaffUserId, note: by.note,
      },
      ipAddress: by.ipAddress,
    }, tx)
    return { ok: true as const }
  })
}

/** The client's staff-set identities still waiting for confirmation, for the card on the client record. */
export async function unconfirmedIdentities(tenantId: string, clientId: string): Promise<{ id: string; channel: "EMAIL" | "WHATSAPP"; display: string }[]> {
  const rows = await prisma.contactIdentity.findMany({
    where: { tenantId, channel: { in: [...CONFIRMABLE_CHANNELS] }, setByStaffUserId: { not: null }, confirmedAt: null, contact: { clientId } },
    select: { id: true, channel: true, value: true },
  })
  return rows.map((row) => ({ id: row.id, channel: row.channel as "EMAIL" | "WHATSAPP", display: row.value.replace("@s.whatsapp.net", "") }))
}
