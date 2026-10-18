import type { Prisma } from "@prisma/client"
/** Preparation can be held before any statement exists. Never relabel that as
 * an issued exception when the first actual statement followed payment. */
export function issuedHeldSurplusException(row: { exceptionReason: string | null; releasedAt: Date | null }, firstNotice: { createdAt: Date; newValue: Prisma.JsonValue } | null) {
  if (!row.exceptionReason || !firstNotice) return false
  const data = firstNotice.newValue
  if (data && typeof data === "object" && !Array.isArray(data) && data.surplusDisposition === "HELD_NO_VERIFIED_ACCOUNT") return true
  // Earlier PR-only notices did not store disposition in their audit value.
  return Boolean(row.releasedAt && firstNotice.createdAt < row.releasedAt)
}
