/**
 * What a dealer captures through the portal: a business entity, a person (a
 * minimal Client, optionally linked to one of the dealer's entities in its
 * roles), a sole proprietor (the same minimal Client), and an asset. Each goes
 * through the code the staff routes use (lib/asset-finance/entity-create.ts,
 * asset-create.ts, relationship-input.ts) and carries createdByDealerId, which
 * the database writes once (migration 20261019120200).
 *
 * A duplicate (Client on idNumber or email, entity on registration number,
 * asset on serial or VIN) answers 409 and shows nothing of the existing row:
 * a dealer sees only what the borrower gave through that dealer (spec
 * deviation 9). An entity the dealer did not capture is "not found".
 *
 * That 409 still says the row exists, so each one is audited
 * (DEALER_CAPTURE_REFUSED_ON_BOOK: the dealer user and what kind of row, never
 * the values typed) and every dealer user's captures are rate limited
 * (DEALER_CAPTURE_RATE_LIMIT, in memory like the sign-in buckets).
 */
import { Prisma, type EntityRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { checkRateLimit } from "@/lib/rate-limit"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { createBusinessEntity } from "@/lib/asset-finance/entity-create"
import { createFinancedAsset } from "@/lib/asset-finance/asset-create"
import { parseBusinessEntityInput } from "@/lib/asset-finance/entity-input"
import { parseAssetCreate } from "@/lib/asset-finance/asset-input"
import { parseRelationshipInput, relationshipRowValues, type RelationshipInput } from "@/lib/asset-finance/relationship-input"
import { isValidSaIdNumber } from "@/lib/validation/client-wizard"
import { dealerAuditFields, type DealerActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export const ALREADY_ON_BOOK = "Already on the lender's book: ask the lender"
const LENDERS_PEOPLE = "This business has a deal with the lender: ask the lender to add the person"

export type CaptureResult = { kind: "created"; id: string } | { kind: "invalid"; fields: Record<string, string> } | DealerRefusal

/** Captures (of every kind) per dealer user per window. */
export const DEALER_CAPTURE_RATE_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 } as const

type Captured = "entity" | "person" | "asset"

function overCaptureLimit(actor: DealerActor): DealerRefusal | null {
  const gate = checkRateLimit(`dealer-capture:${actor.tenantId}:${actor.dealerUserId}`, DEALER_CAPTURE_RATE_LIMIT)
  return gate.allowed ? null : dealerRefused(429, "Too many captures in a short time: try again in a few minutes")
}

/** The 409 for a row already on the lender's book, audited (outside any transaction the refusal aborted). */
async function alreadyOnBook(actor: DealerActor, captured: Captured): Promise<DealerRefusal> {
  const audit = dealerAuditFields(actor)
  await auditRefusal({
    // The audited row is the dealer user's attempt; the existing row is never named.
    action: AuditAction.DEALER_CAPTURE_REFUSED_ON_BOOK, entity: "DealerUser", entityId: actor.dealerUserId,
    tenantId: actor.tenantId, userEmail: audit.userEmail, reason: "already_on_book", status: 409,
    detail: { captured, actor: audit.actor },
  })
  return dealerRefused(409, ALREADY_ON_BOOK)
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[0-9 ]{9,15}$/

export type DealerPersonInput = {
  idNumber: string; firstName: string; lastName: string; email: string; phone: string
  addressLine1: string | null; suburb: string | null; city: string | null; province: string | null; postalCode: string | null
}

/**
 * A borrower the dealer captures carries its address (a first line and a
 * city, as booking's tax invoice needs: lib/asset-finance/booking-load.ts
 * recipientAddress); it is fixed once the deal is approved, so it cannot be
 * added at booking. A person of a business needs none.
 */
function missingAddress(address: { addressLine1: string | null; city: string | null }): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!address.addressLine1) errors.addressLine1 = "Required: the lender's tax invoice needs the borrower's address"
  if (!address.city) errors.city = "Required"
  return errors
}

/** The person's fields; `soleProprietor` (the borrower itself) also requires the address. */
export function parseDealerPerson(body: unknown, soleProprietor = false): { data: DealerPersonInput } | { errors: Record<string, string> } {
  const b = (body ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof b[key] === "string" ? (b[key] as string).trim() : "")
  const optional = (key: string) => text(key) || null
  const data = {
    idNumber: text("idNumber"), firstName: text("firstName"), lastName: text("lastName"),
    email: text("email").toLowerCase(), phone: text("phone"),
    addressLine1: optional("addressLine1"), suburb: optional("suburb"), city: optional("city"), province: optional("province"),
    postalCode: optional("postalCode"),
  }
  const errors: Record<string, string> = soleProprietor ? missingAddress(data) : {}
  if (!isValidSaIdNumber(data.idNumber)) errors.idNumber = "A valid South African ID number is required"
  if (data.firstName.length < 1 || data.firstName.length > 100) errors.firstName = "Required, at most 100 characters"
  if (data.lastName.length < 1 || data.lastName.length > 100) errors.lastName = "Required, at most 100 characters"
  if (!EMAIL.test(data.email) || data.email.length > 200) errors.email = "A valid email address is required"
  if (!PHONE.test(data.phone)) errors.phone = "A phone number of 9-15 digits"
  // The staff entity rules (lib/asset-finance/entity-input.ts).
  for (const [key, max] of [["addressLine1", 200], ["suburb", 100], ["city", 100], ["province", 100]] as const) {
    if ((data[key]?.length ?? 0) > max) errors[key] = `At most ${max} characters`
  }
  if (data.postalCode && !/^\d{4}$/.test(data.postalCode)) errors.postalCode = "Four digits"
  return Object.keys(errors).length > 0 ? { errors } : { data }
}

const addressOf = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof b[key] === "string" && (b[key] as string).trim() ? (b[key] as string).trim() : null)
  return { addressLine1: text("addressLine1"), city: text("city") }
}

export async function captureDealerEntity(actor: DealerActor, body: unknown): Promise<CaptureResult> {
  const limited = overCaptureLimit(actor)
  if (limited) return limited
  const input = parseBusinessEntityInput(body)
  if ("errors" in input) return { kind: "invalid", fields: { ...missingAddress(addressOf(body)), ...input.errors } }
  const noAddress = missingAddress(input.data)
  if (Object.keys(noAddress).length > 0) return { kind: "invalid", fields: noAddress }
  const created = await createBusinessEntity({ kind: "dealer", actor }, input.data)
  return created.kind === "duplicate" ? alreadyOnBook(actor, "entity") : created
}

export async function captureDealerAsset(actor: DealerActor, body: unknown): Promise<CaptureResult> {
  const limited = overCaptureLimit(actor)
  if (limited) return limited
  const parsed = parseAssetCreate(body)
  if ("errors" in parsed) return { kind: "invalid", fields: parsed.errors }
  const created = await createFinancedAsset({ kind: "dealer", actor }, parsed.data)
  if (created.kind === "invalid") return created
  if (created.kind === "duplicate") return alreadyOnBook(actor, "asset")
  return { kind: "created", id: created.asset.id }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** One EntityRelationship row for the new person, audited as the staff people route does. */
async function linkPerson(
  tx: Tx,
  actor: DealerActor,
  row: { entityId: string; relationship: RelationshipInput; clientId: string; clientReference: string; role: EntityRole },
): Promise<void> {
  const values = relationshipRowValues(row.relationship, row.role)
  const created = await tx.entityRelationship.create({
    data: { tenantId: actor.tenantId, entityId: row.entityId, clientId: row.clientId, role: row.role, ...values },
    select: { id: true },
  })
  const audit = dealerAuditFields(actor)
  await logAuditStrict({
    tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
    action: AuditAction.ENTITY_RELATIONSHIP_ADDED, entity: "EntityRelationship", entityId: created.id,
    newValue: {
      businessEntityId: row.entityId, clientId: row.clientId, clientReference: row.clientReference, role: row.role, ...values,
      reactivated: false, actor: audit.actor,
    },
  }, tx)
}

/**
 * A new person captured by the dealer: a sole proprietor (no `entityId`), or
 * a person of one of the dealer's own entities in `roles` (body.roles,
 * body.trusteeKind, body.ownershipPct as the staff people route takes them),
 * while the entity has no deal beyond this dealer's own unsubmitted draft:
 * from then on the lender adds people, since a dealer-added person would
 * receive that deal's messages (EntityRelationship_dealer_contact_link).
 */
export async function captureDealerPerson(actor: DealerActor, body: unknown, entityId: string | null = null): Promise<CaptureResult> {
  const limited = overCaptureLimit(actor)
  if (limited) return limited
  const person = parseDealerPerson(body, entityId === null)
  const entity = entityId === null ? null : await prisma.businessEntity.findFirst({
    where: { id: entityId, tenantId: actor.tenantId, createdByDealerId: actor.dealerId },
    select: { id: true, type: true },
  })
  if (entityId !== null && !entity) return dealerMiss("Entity")
  // Validated before anything is written (the client id it names is the new row's).
  let link: { entityId: string; relationship: RelationshipInput } | null = null
  if (entity) {
    const parsed = parseRelationshipInput({ ...(body as Record<string, unknown>), clientId: "new" }, entity.type)
    if ("errors" in parsed) return { kind: "invalid", fields: { ...("errors" in person ? person.errors : {}), ...parsed.errors } }
    link = { entityId: entity.id, relationship: parsed.data }
  }
  if ("errors" in person) return { kind: "invalid", fields: person.errors }
  const linked = link

  const audit = dealerAuditFields(actor)
  try {
    const id = await prisma.$transaction(async (tx) => {
      // The friendly answer to EntityRelationship_dealer_contact_link, which the database enforces again.
      if (linked && await tx.assetFinanceDeal.count({
        where: {
          tenantId: actor.tenantId, entityId: linked.entityId, status: { not: "CANCELLED" },
          // Any deal but this dealer's own unsubmitted draft; a staff deal (dealerId NULL) is spelled out,
          // since NOT on a nullable column alone would let SQL NULL semantics skip it.
          OR: [{ dealerId: null }, { NOT: { dealerId: actor.dealerId } }, { dealerSubmittedAt: { not: null } }],
        },
      }) > 0) {
        return null
      }
      const client = await tx.client.create({
        data: { tenantId: actor.tenantId, ...person.data, createdByDealerId: actor.dealerId },
        select: { id: true, reference: true },
      })
      await logAuditStrict({
        tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
        action: AuditAction.CLIENT_CREATED, entity: "Client", entityId: client.id,
        newValue: { reference: client.reference, capturedBy: "dealer", actor: audit.actor },
      }, tx)
      if (linked) {
        for (const role of linked.relationship.roles) {
          await linkPerson(tx, actor, { ...linked, clientId: client.id, clientReference: client.reference, role })
        }
      }
      return client.id
    })
    return id === null ? dealerRefused(409, LENDERS_PEOPLE) : { kind: "created", id }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return alreadyOnBook(actor, "person")
    if (isCheckViolation(error) && String(error).includes("joins a business only while")) return dealerRefused(409, LENDERS_PEOPLE)
    throw error
  }
}
