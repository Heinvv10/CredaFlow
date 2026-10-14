/**
 * The DebitMandate lifecycle. Mirrored by the trigger guardDebitMandateStatus
 * (migration 20261014150000_collections_engine), which refuses any other move.
 *
 *   CREATED ─► PENDING_AUTH ─► ACTIVE ─► SUSPENDED ─► CANCELLED
 *      │            ├─► REJECTED  │
 *      │            └─► EXPIRED   └─► CANCELLED
 *      └─► ACTIVE (rail authorised at once) / REJECTED / CANCELLED
 *
 * SUSPENDED never returns to ACTIVE: the scheme requires a fresh mandate.
 */
import type { DebitMandateStatus } from "@prisma/client"
import type { MandateStatusValue } from "@/lib/integrations/collections/types"

export const MANDATE_TRANSITIONS: Readonly<Record<DebitMandateStatus, readonly DebitMandateStatus[]>> = {
  CREATED: ["PENDING_AUTH", "ACTIVE", "REJECTED", "CANCELLED"],
  PENDING_AUTH: ["ACTIVE", "REJECTED", "EXPIRED", "CANCELLED"],
  ACTIVE: ["SUSPENDED", "CANCELLED"],
  SUSPENDED: ["CANCELLED"],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
}

/** Statuses in which a mandate blocks a second one on the same loan (DebitMandate_one_live_per_loan). */
export const LIVE_MANDATE_STATUSES: readonly DebitMandateStatus[] = ["CREATED", "PENDING_AUTH", "ACTIVE"]

export function canTransition(from: DebitMandateStatus, to: DebitMandateStatus): boolean {
  return MANDATE_TRANSITIONS[from].includes(to)
}

export function fromProviderStatus(status: MandateStatusValue): DebitMandateStatus {
  switch (status) {
    case "AUTHENTICATED":
      return "ACTIVE"
    case "PENDING_AUTH":
    case "REJECTED":
    case "EXPIRED":
    case "SUSPENDED":
    case "CANCELLED":
      return status
  }
}
