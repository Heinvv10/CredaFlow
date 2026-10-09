import { Prisma } from "@prisma/client"

/**
 * States that reserve the one open application slot for a client/product.
 * Keep this list aligned with the partial unique index
 * LoanApplication_one_open_per_client_product_idx.
 */
export const OPEN_APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
] as const

/**
 * Prisma normalises PostgreSQL unique violations to P2002. Callers must still
 * re-read the open application after this check before translating the error
 * to a duplicate-application response: LoanApplication.reference is also
 * unique, and a reference collision must not be misreported as an open case.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}
