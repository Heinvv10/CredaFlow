/**
 * Provision a Contact + per-channel ContactIdentity rows for a newly-created
 * Client. Required by the new-send cutover because the new-send
 * path (lib/messaging/send.ts) looks up the recipient by channel-keyed
 * ContactIdentity. Without provisioning at client-create time, transactional
 * notifications for new clients silently drop on the floor.
 *
 * Idempotent: re-running for the same client is a no-op. Existing Contact
 * rows (e.g. from the Phase 9 backfill) are reused; existing ContactIdentity
 * rows are not duplicated.
 *
 * Must be called inside the same Prisma transaction as the Client create so
 * Client + Contact land atomically. Otherwise a half-provisioned state
 * (Client without Contact) defeats the point.
 */

import { Prisma, type Channel, type Contact, type ContactIdentity, type IdentitySource } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { normaliseEmail, normalisePhone, toWaJid } from "./identity"

export interface ProvisionInput {
  tenantId: string
  clientId: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  whatsapp?: string | null
  /**
   * IdentitySource for the new identity rows. Defaults to APPLICATION_FORM
   * (the canonical capture surface). Lead-conversion sites can override
   * with MANUAL to record that staff drove the convert.
   */
  source?: IdentitySource
}

// Transaction client shape we need — picks the two model delegates we touch
// from the live prisma client type. Same pattern as `PrismaLike` in
// lib/messaging/types.ts so we accept either prisma directly or a real
// `tx` from `prisma.$transaction(async (tx) => ...)`.
type TxLike = Pick<typeof prisma, "$queryRaw" | "contact" | "contactIdentity">

interface ChannelValue {
  channel: Channel
  value: string
}

function collectChannelValues(
  input: Pick<ProvisionInput, "email" | "phone" | "whatsapp">,
): ChannelValue[] {
  const out: ChannelValue[] = []
  if (input.email) {
    const e = normaliseEmail(input.email)
    if (e) out.push({ channel: "EMAIL", value: e })
  }
  if (input.phone) {
    const p = normalisePhone(input.phone)
    if (p) out.push({ channel: "SMS", value: p })
  }
  if (input.whatsapp) {
    const j = toWaJid(input.whatsapp)
    if (j) out.push({ channel: "WHATSAPP", value: j })
  }
  // De-dupe — when a client's SMS number and WhatsApp number are the same E.164
  // we still want both identity rows (channel-keyed lookup), so don't collapse.
  return out
}

export interface ProvisionResult {
  contact: Contact
  /** Identity rows that EXISTED before this call — left untouched. */
  preExistingIdentities: ContactIdentity[]
  /** Identity rows created by this call. */
  createdIdentities: ContactIdentity[]
}

export async function provisionContactForClient(
  tx: TxLike,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  // 1. Find-or-create the Contact for this client. Contact.clientId is @unique
  //    so at most one Contact per client exists. Reuse if present.
  const existingContact = await tx.contact.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  })

  const contact =
    existingContact ??
    (await tx.contact.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        primaryEmail: input.email ? normaliseEmail(input.email) : null,
        primaryPhone: input.phone ? normalisePhone(input.phone) : null,
        primaryWaJid: input.whatsapp ? toWaJid(input.whatsapp) : null,
        status: "CLIENT",
        // Required: Contact.firstSeenChannel has no schema default. MANUAL
        // marks "captured via app / staff form" — i.e. not via any inbound
        // messaging surface. Mirrors the Phase 9 backfill convention.
        firstSeenChannel: "MANUAL",
        firstSeenContext: "client_create",
      },
    }))

  // 2. Provision identity rows per channel.
  //    The schema has `@@unique([tenantId, channel, value])` on ContactIdentity,
  //    so two Contacts in the same tenant cannot share an identity value. We
  //    scope `findFirst` by contactId so we only no-op when the row already
  //    belongs to THIS Contact. If a row exists for a different Contact (e.g.
  //    Lead → Client conversion where the Lead-Contact already owns the phone),
  //    the create attempt below will throw P2002 — the surrounding
  //    `prisma.$transaction` will roll back, the operator sees the collision
  //    explicitly rather than getting silent mis-routing of future messages
  //    to the Lead Contact via `lookupContactByChannelValue`.
  //
  //    Resolution of a real-world Lead→Client identity merge is the Phase 9
  //    backfill / merge flow, not this hot-path helper.
  const source = input.source ?? "APPLICATION_FORM"
  const preExisting: ContactIdentity[] = []
  const created: ContactIdentity[] = []

  for (const { channel, value } of collectChannelValues(input)) {
    const existing = await tx.contactIdentity.findFirst({
      where: { tenantId: input.tenantId, channel, value, contactId: contact.id },
    })
    if (existing) {
      preExisting.push(existing)
      continue
    }
    const row = await tx.contactIdentity.create({
      data: {
        tenantId: input.tenantId,
        contactId: contact.id,
        channel,
        value,
        source,
        verified: false,
      },
    })
    created.push(row)
  }

  return { contact, preExistingIdentities: preExisting, createdIdentities: created }
}

export interface ProvisionLeadInput {
  tenantId: string
  leadId: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  whatsapp?: string | null
  /**
   * IdentitySource for the new identity rows. Defaults to MANUAL — the CRM
   * lead-create form is a staff-driven capture surface.
   */
  source?: IdentitySource
}

export interface ResolveLeadConversionContactInput extends ProvisionInput {
  leadId: string
  /**
   * Recovery may target a Client that already has a canonical Contact from a
   * prior application. Contact.leadId is intentionally one-to-one, while a
   * Client can have many converted Leads, so recovery must reuse that Contact
   * without trying to replace its representative lead link.
   */
  reuseExistingClientContact?: boolean
  /**
   * Public application recovery must reconcile the currently submitted
   * channel values with the canonical Client Contact. Staff-driven recovery
   * keeps the historical no-op default unless it opts in explicitly.
   */
  reconcileIdentitiesOnReuse?: boolean
}

export interface ContactPromotionResult extends ProvisionResult {
  created: boolean
  resolution:
    | "PROMOTED_LEAD_CONTACT"
    | "CREATED_CONTACT"
    | "LINKED_CLIENT_CONTACT"
    | "REUSED_CLIENT_CONTACT"
  previous: {
    clientId: string | null
    leadId: string | null
    status: Contact["status"]
    primaryEmail: string | null
    primaryPhone: string | null
    primaryWaJid: string | null
  } | null
}

export class ContactPromotionConflictError extends Error {
  constructor(
    readonly reason:
      | "SPLIT_CONTACTS"
      | "CLIENT_MISMATCH"
      | "LEAD_MISMATCH"
      | "IDENTITY_OWNED_ELSEWHERE"
      | "CONTACT_STATUS_NOT_CONVERTIBLE",
  ) {
    super(`Lead contact cannot be promoted: ${reason}`)
    this.name = "ContactPromotionConflictError"
  }
}

/**
 * Reuse the Lead's Contact when it becomes a Client. Creating a second
 * Contact would collide on the tenant-wide email/phone identities that the
 * normal lead-create path already owns and would split one person's message
 * history across two directory rows.
 *
 * Must run in the same transaction as the lead conversion. Distinct existing
 * Lead and Client Contacts are not silently merged here: that requires the
 * audited ContactMerge workflow because each side may already own consents,
 * conversations, or privacy history.
 */
export async function resolveContactForLeadConversion(
  tx: TxLike,
  input: ResolveLeadConversionContactInput,
): Promise<ContactPromotionResult> {
  // Serialize every conversion/recovery for the canonical Client. The
  // advisory lock also covers the no-Contact-yet case where no physical row
  // exists to lock, while the row lock coordinates with directory workflows
  // that lock Contact rows directly. Re-read only after both locks are held.
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`contact-conversion:${input.tenantId}:${input.clientId}`})
    )::text AS "lockResult"
  `)
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "Contact"
    WHERE "tenantId" = ${input.tenantId}
      AND ("leadId" = ${input.leadId} OR "clientId" = ${input.clientId})
    ORDER BY "id"
    FOR UPDATE
  `)

  const [leadContact, clientContact] = await Promise.all([
    tx.contact.findFirst({ where: { tenantId: input.tenantId, leadId: input.leadId } }),
    tx.contact.findFirst({ where: { tenantId: input.tenantId, clientId: input.clientId } }),
  ])

  const previousValue = (contact: Contact) => ({
    clientId: contact.clientId,
    leadId: contact.leadId,
    status: contact.status,
    primaryEmail: contact.primaryEmail,
    primaryPhone: contact.primaryPhone,
    primaryWaJid: contact.primaryWaJid,
  })
  const assertConvertibleStatus = (contact: Contact) => {
    if (contact.status === "MERGED" || contact.status === "STAFF") {
      throw new ContactPromotionConflictError("CONTACT_STATUS_NOT_CONVERTIBLE")
    }
  }
  if (leadContact) assertConvertibleStatus(leadContact)

  // A repeat Client can own one canonical Contact while accumulating many
  // converted Leads. During recovery preserve that Contact exactly as-is;
  // forcing its singular leadId to the current Lead would either detach the
  // earlier conversion or make every later conversion unrecoverable. A
  // separate legacy Lead Contact remains available for its historical CRM
  // conversation until an explicit, audited ContactMerge is performed.
  const canLinkUnattributedClientContact =
    clientContact !== null &&
    input.reuseExistingClientContact === true &&
    clientContact.leadId === null &&
    leadContact === null

  if (
    clientContact &&
    input.reuseExistingClientContact &&
    !canLinkUnattributedClientContact
  ) {
    assertConvertibleStatus(clientContact)
    if (!input.reconcileIdentitiesOnReuse) {
      return {
        contact: clientContact,
        created: false,
        resolution: "REUSED_CLIENT_CONTACT",
        previous: previousValue(clientContact),
        preExistingIdentities: [],
        createdIdentities: [],
      }
    }
  }

  const reusingCanonicalClientContact =
    clientContact !== null &&
    input.reuseExistingClientContact === true &&
    !canLinkUnattributedClientContact

  if (
    !reusingCanonicalClientContact &&
    leadContact &&
    clientContact &&
    leadContact.id !== clientContact.id
  ) {
    throw new ContactPromotionConflictError("SPLIT_CONTACTS")
  }

  const existing = reusingCanonicalClientContact
    ? clientContact
    : leadContact ?? clientContact
  if (existing?.clientId && existing.clientId !== input.clientId) {
    throw new ContactPromotionConflictError("CLIENT_MISMATCH")
  }
  if (
    !reusingCanonicalClientContact &&
    existing?.leadId &&
    existing.leadId !== input.leadId
  ) {
    throw new ContactPromotionConflictError("LEAD_MISMATCH")
  }
  if (existing) assertConvertibleStatus(existing)

  const previous = existing ? previousValue(existing) : null
  const contact = existing
    ? await tx.contact.update({
        where: { id: existing.id },
        data: {
          ...(!reusingCanonicalClientContact && {
            clientId: input.clientId,
            leadId: input.leadId,
          }),
          firstName: input.firstName ?? existing.firstName,
          lastName: input.lastName ?? existing.lastName,
          primaryEmail: input.email ? normaliseEmail(input.email) : existing.primaryEmail,
          primaryPhone: input.phone ? normalisePhone(input.phone) : existing.primaryPhone,
          primaryWaJid: input.whatsapp ? toWaJid(input.whatsapp) : existing.primaryWaJid,
          // Suppression/archive states are load-bearing messaging controls.
          // Only an ordinary Lead is promoted; every other convertible state
          // is retained exactly.
          status: existing.status === "LEAD" ? "CLIENT" : existing.status,
        },
      })
    : await tx.contact.create({
        data: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          leadId: input.leadId,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          primaryEmail: input.email ? normaliseEmail(input.email) : null,
          primaryPhone: input.phone ? normalisePhone(input.phone) : null,
          primaryWaJid: input.whatsapp ? toWaJid(input.whatsapp) : null,
          status: "CLIENT",
          firstSeenChannel: "MANUAL",
          firstSeenContext: "lead_conversion",
        },
      })

  const source = input.source ?? "MANUAL"
  const preExisting: ContactIdentity[] = []
  const created: ContactIdentity[] = []
  for (const { channel, value } of collectChannelValues(input)) {
    const identity = await tx.contactIdentity.findFirst({
      where: { tenantId: input.tenantId, channel, value },
    })
    if (identity) {
      if (identity.contactId !== contact.id) {
        throw new ContactPromotionConflictError("IDENTITY_OWNED_ELSEWHERE")
      }
      preExisting.push(identity)
      continue
    }
    try {
      created.push(await tx.contactIdentity.create({
        data: {
          tenantId: input.tenantId,
          contactId: contact.id,
          channel,
          value,
          source,
          verified: false,
        },
      }))
    } catch (error) {
      // The tenant/channel/value unique index is the final cross-Client race
      // authority. Same-Client writers are serialized by the advisory lock,
      // so a P2002 here means another Contact owns the submitted identity.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ContactPromotionConflictError("IDENTITY_OWNED_ELSEWHERE")
      }
      throw error
    }
  }

  return {
    contact,
    created: existing === null,
    resolution:
      reusingCanonicalClientContact
        ? "REUSED_CLIENT_CONTACT"
        : existing === null
        ? "CREATED_CONTACT"
        : canLinkUnattributedClientContact
          ? "LINKED_CLIENT_CONTACT"
          : "PROMOTED_LEAD_CONTACT",
    previous,
    preExistingIdentities: preExisting,
    createdIdentities: created,
  }
}

/**
 * Provision a Contact + per-channel ContactIdentity rows for a newly-created
 * Lead, so the lead is visible in the unified Contact directory and reachable
 * by the channel-keyed messaging-eligibility lookup (canSend). Mirrors
 * provisionContactForClient but is keyed on Contact.leadId / status LEAD.
 *
 * Must be called inside the same Prisma transaction as the Lead create so
 * Lead + Contact land atomically.
 *
 * Divergence from the client path: an identity value already owned by a
 * DIFFERENT Contact is skipped (not created) rather than left to throw P2002.
 * Leads are high-volume and duplicate enquiries from the same phone/email are
 * normal; failing the lead create on a shared channel would be a regression.
 * The claimed channel already routes to the existing Contact — reconciling the
 * two is the Phase 9 merge flow, not this hot path.
 */
export async function provisionContactForLead(
  tx: TxLike,
  input: ProvisionLeadInput,
): Promise<ProvisionResult> {
  // Find-or-create the Contact for this lead. Contact.leadId is @unique, so at
  // most one Contact per lead exists. Reuse if present (idempotent).
  const existingContact = await tx.contact.findFirst({
    where: { tenantId: input.tenantId, leadId: input.leadId },
  })

  const contact =
    existingContact ??
    (await tx.contact.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        primaryEmail: input.email ? normaliseEmail(input.email) : null,
        primaryPhone: input.phone ? normalisePhone(input.phone) : null,
        primaryWaJid: input.whatsapp ? toWaJid(input.whatsapp) : null,
        status: "LEAD",
        firstSeenChannel: "MANUAL",
        firstSeenContext: "lead_create",
      },
    }))

  const source = input.source ?? "MANUAL"
  const preExisting: ContactIdentity[] = []
  const created: ContactIdentity[] = []

  for (const { channel, value } of collectChannelValues(input)) {
    // Tenant-wide existence check (NOT scoped to this Contact): the
    // @@unique([tenantId, channel, value]) means the value can belong to at
    // most one Contact. If it already exists — ours or another Contact's — we
    // must not create a duplicate (see divergence note above).
    const existing = await tx.contactIdentity.findFirst({
      where: { tenantId: input.tenantId, channel, value },
    })
    if (existing) {
      if (existing.contactId === contact.id) preExisting.push(existing)
      // else: claimed by a different Contact — skip silently.
      continue
    }
    const row = await tx.contactIdentity.create({
      data: {
        tenantId: input.tenantId,
        contactId: contact.id,
        channel,
        value,
        source,
        verified: false,
      },
    })
    created.push(row)
  }

  return { contact, preExistingIdentities: preExisting, createdIdentities: created }
}
