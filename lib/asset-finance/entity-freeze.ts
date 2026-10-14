import type { BusinessEntityInput } from "./entity-input"

/** Entity facts printed into the agreement and later copied onto tax records. */
export const SIGNED_ENTITY_FIELDS = [
  "type",
  "legalName",
  "tradingName",
  "registrationNumber",
  "mastersReference",
  "vatNumber",
  "addressLine1",
  "addressLine2",
  "city",
  "province",
  "postalCode",
] as const satisfies readonly (keyof BusinessEntityInput)[]

export type SignedEntityField = (typeof SIGNED_ENTITY_FIELDS)[number]

export function signedEntityChanges(
  before: Pick<BusinessEntityInput, SignedEntityField>,
  after: Pick<BusinessEntityInput, SignedEntityField>,
): SignedEntityField[] {
  return SIGNED_ENTITY_FIELDS.filter((field) => before[field] !== after[field])
}
