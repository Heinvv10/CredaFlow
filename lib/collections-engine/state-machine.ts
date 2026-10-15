/**
 * The DebitMandate lifecycle. Mirrored by the trigger guardDebitMandateStatus
 * (migration 20261014150000_collections_engine), which refuses any other move.
 *
 *   CREATED ─► SUBMITTING ─► PENDING_REGISTRATION ─► PENDING_AUTH ─► ACTIVE ─► SUSPENDED
 *      ▲            │              (file-based rail)        ├─► REJECTED / EXPIRED
 *      └── retry ───┤                                       └─► CANCELLED (any live state)
 *                   └─► PENDING_AUTH / ACTIVE / REJECTED (synchronous rail)
 *
 * SUBMITTING is one writer's claim on the provider call (staff create vs the
 * cron). A failed call returns it to CREATED for a retry with backoff.
 * SUSPENDED never returns to ACTIVE: the scheme requires a fresh mandate.
 */
import type { DebitMandateStatus } from "@prisma/client"
import type { MandateStatusValue } from "@/lib/integrations/collections/types"

export const MANDATE_TRANSITIONS: Readonly<Record<DebitMandateStatus, readonly DebitMandateStatus[]>> = {
  CREATED: ["SUBMITTING", "CANCELLED"],
  SUBMITTING: ["CREATED", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE", "REJECTED", "CANCELLED"],
  PENDING_REGISTRATION: ["PENDING_AUTH", "ACTIVE", "REJECTED", "EXPIRED", "CANCELLED"],
  PENDING_AUTH: ["ACTIVE", "REJECTED", "EXPIRED", "CANCELLED"],
  // EXPIRED / REJECTED: only ever reported by the provider (the debtor's bank ended it).
  ACTIVE: ["SUSPENDED", "CANCELLED", "EXPIRED", "REJECTED"],
  SUSPENDED: ["CANCELLED"],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
}

/** Statuses in which a mandate blocks a second one on the same loan (DebitMandate_one_live_per_loan). */
export const LIVE_MANDATE_STATUSES: readonly DebitMandateStatus[] = ["CREATED", "SUBMITTING", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE"]

export function canTransition(from: DebitMandateStatus, to: DebitMandateStatus): boolean {
  return MANDATE_TRANSITIONS[from].includes(to)
}

export function fromProviderStatus(status: MandateStatusValue): DebitMandateStatus {
  switch (status) {
    case "AUTHENTICATED":
      return "ACTIVE"
    case "PENDING_REGISTRATION":
    case "PENDING_AUTH":
    case "REJECTED":
    case "EXPIRED":
    case "SUSPENDED":
    case "CANCELLED":
      return status
  }
}
