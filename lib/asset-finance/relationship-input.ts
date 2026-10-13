import type { BusinessEntityType, EntityRole, TrusteeKind } from "@prisma/client"

// Validation of "link this Client to this entity in these roles". One
// EntityRelationship row is written per role. The role must fit the entity's
// type: only a trust has trustees, only a company has directors, and a CC's
// members or a partnership's partners are MEMBERs.

export const ENTITY_ROLES: readonly EntityRole[] = [
  "DIRECTOR",
  "MEMBER",
  "TRUSTEE",
  "AUTHORISED_SIGNATORY",
  "SURETY",
  "BENEFICIAL_OWNER",
]

const COMMON_ROLES: readonly EntityRole[] = ["AUTHORISED_SIGNATORY", "SURETY", "BENEFICIAL_OWNER"]

export const ROLES_BY_ENTITY_TYPE: Record<BusinessEntityType, readonly EntityRole[]> = {
  COMPANY: ["DIRECTOR", ...COMMON_ROLES],
  CC: ["MEMBER", ...COMMON_ROLES],
  TRUST: ["TRUSTEE", ...COMMON_ROLES],
  PARTNERSHIP: ["MEMBER", ...COMMON_ROLES],
}

/** Roles whose rows carry an ownership share. */
const OWNERSHIP_ROLES: readonly EntityRole[] = ["MEMBER", "BENEFICIAL_OWNER"]

export interface RelationshipInput {
  clientId: string
  roles: EntityRole[]
  trusteeKind: TrusteeKind | null
  ownershipPct: string | null
}

export type RelationshipInputResult = { data: RelationshipInput } | { errors: Record<string, string> }

export function parseRelationshipInput(body: unknown, entityType: BusinessEntityType): RelationshipInputResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { errors: { body: "Expected a JSON object" } }
  }
  const b = body as Record<string, unknown>
  const errors: Record<string, string> = {}

  const clientId = typeof b.clientId === "string" ? b.clientId.trim() : ""
  if (!clientId) errors.clientId = "Required"

  const allowed = ROLES_BY_ENTITY_TYPE[entityType]
  const roles: EntityRole[] = []
  if (!Array.isArray(b.roles) || b.roles.length === 0) {
    errors.roles = "Choose at least one role"
  } else {
    for (const role of b.roles) {
      if (typeof role !== "string" || !(ENTITY_ROLES as readonly string[]).includes(role)) {
        errors.roles = `Roles are ${ENTITY_ROLES.join(", ")}`
        break
      }
      if (!allowed.includes(role as EntityRole)) {
        errors.roles = `A ${entityType} takes ${allowed.join(", ")}`
        break
      }
      if (!roles.includes(role as EntityRole)) roles.push(role as EntityRole)
    }
  }

  let trusteeKind: TrusteeKind | null = null
  if (roles.includes("TRUSTEE")) {
    if (b.trusteeKind === "NATURAL" || b.trusteeKind === "JURISTIC") trusteeKind = b.trusteeKind
    else errors.trusteeKind = "A trustee is NATURAL or JURISTIC"
  } else if (b.trusteeKind !== undefined && b.trusteeKind !== null && b.trusteeKind !== "") {
    errors.trusteeKind = "Only a trustee has a trustee kind"
  }

  let ownershipPct: string | null = null
  const rawPct = b.ownershipPct
  if (rawPct !== undefined && rawPct !== null && rawPct !== "") {
    const text = typeof rawPct === "number" ? String(rawPct) : typeof rawPct === "string" ? rawPct.trim() : ""
    const value = Number(text)
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(text) || value > 100) {
      errors.ownershipPct = "A percentage from 0 to 100, at most two decimals"
    } else if (!roles.some((r) => OWNERSHIP_ROLES.includes(r))) {
      errors.ownershipPct = "Only a member or beneficial owner holds a share"
    } else {
      ownershipPct = text
    }
  }

  if (Object.keys(errors).length > 0) return { errors }
  return { data: { clientId, roles, trusteeKind, ownershipPct } }
}

/** The column values of the row for one role of a parsed input. */
export function relationshipRowValues(input: RelationshipInput, role: EntityRole): {
  trusteeKind: TrusteeKind | null
  ownershipPct: string | null
} {
  return {
    trusteeKind: role === "TRUSTEE" ? input.trusteeKind : null,
    ownershipPct: OWNERSHIP_ROLES.includes(role) ? input.ownershipPct : null,
  }
}
