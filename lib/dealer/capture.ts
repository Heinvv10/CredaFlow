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
 */
import { Prisma, type EntityRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { createBusinessEntity } from "@/lib/asset-finance/entity-create"
import { createFinancedAsset } from "@/lib/asset-finance/asset-create"
import { parseBusinessEntityInput } from "@/lib/asset-finance/entity-input"
import { parseAssetCreate } from "@/lib/asset-finance/asset-input"
import { parseRelationshipInput, relationshipRowValues, type RelationshipInput } from "@/lib/asset-finance/relationship-input"
import { isValidSaIdNumber } from "@/lib/validation/client-wizard"
import { dealerAuditFields, type DealerActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export const ALREADY_ON_BOOK = "Already on the lender's book: ask the lender"

export type CaptureResult = { kind: "created"; id: string } | { kind: "invalid"; fields: Record<string, string> } | DealerRefusal

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[0-9 ]{9,15}$/

export type DealerPersonInput = { idNumber: string; firstName: string; lastName: string; email: string; phone: string }

export function parseDealerPerson(body: unknown): { data: DealerPersonInput } | { errors: Record<string, string> } {
  const b = (body ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof b[key] === "string" ? (b[key] as string).trim() : "")
  const data = {
    idNumber: text("idNumber"), firstName: text("firstName"), lastName: text("lastName"),
    email: text("email").toLowerCase(), phone: text("phone"),
  }
  const errors: Record<string, string> = {}
  if (!isValidSaIdNumber(data.idNumber)) errors.idNumber = "A valid South African ID number is required"
  if (data.firstName.length < 1 || data.firstName.length > 100) errors.firstName = "Required, at most 100 characters"
  if (data.lastName.length < 1 || data.lastName.length > 100) errors.lastName = "Required, at most 100 characters"
  if (!EMAIL.test(data.email) || data.email.length > 200) errors.email = "A valid email address is required"
  if (!PHONE.test(data.phone)) errors.phone = "A phone number of 9-15 digits"
  return Object.keys(errors).length > 0 ? { errors } : { data }
}

export async function captureDealerEntity(actor: DealerActor, body: unknown): Promise<CaptureResult> {
  const input = parseBusinessEntityInput(body)
  if ("errors" in input) return { kind: "invalid", fields: input.errors }
  const created = await createBusinessEntity({ kind: "dealer", actor }, input.data)
  return created.kind === "duplicate" ? dealerRefused(409, ALREADY_ON_BOOK) : created
}

export async function captureDealerAsset(actor: DealerActor, body: unknown): Promise<CaptureResult> {
  const parsed = parseAssetCreate(body)
  if ("errors" in parsed) return { kind: "invalid", fields: parsed.errors }
  const created = await createFinancedAsset({ kind: "dealer", actor }, parsed.data)
  if (created.kind === "invalid") return created
  if (created.kind === "duplicate") return dealerRefused(409, ALREADY_ON_BOOK)
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
 * body.trusteeKind, body.ownershipPct as the staff people route takes them).
 */
export async function captureDealerPerson(actor: DealerActor, body: unknown, entityId: string | null = null): Promise<CaptureResult> {
  const person = parseDealerPerson(body)
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
    return { kind: "created", id }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return dealerRefused(409, ALREADY_ON_BOOK)
    throw error
  }
}
