import type { Prisma } from "@prisma/client"

/**
 * `clientId` takes an `in` list as well as a single id: the board asks this for
 * every client on it at once. It used to take only a string, so a batching
 * caller passed `""` and spread an override on top — which works only while
 * the override happens to come second, and silently filters on the empty
 * string the moment someone reorders the spread.
 */
export function unresolvedNonBiometricDocumentMismatchWhere(input: {
  tenantId: string
  clientId: string | { in: string[] }
}): Prisma.ClientDocumentWhereInput {
  return {
    tenantId: input.tenantId,
    clientId: input.clientId,
    deletedAt: null,
    docType: { not: "SELFIE" },
    validationMismatch: true,
    verified: false,
  }
}
