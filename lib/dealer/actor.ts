/**
 * Who a dealer-portal action is by. AuditLog.userId is a User FK, so a dealer
 * user's own actions carry no userId: their email, and newValue.actor naming
 * the dealer and the dealer user (the actorType "client" precedent in
 * lib/compliance/pasq-acknowledgement.server.ts). No AuditLog DDL.
 */
import type { DealerRole } from "@prisma/client"

export interface DealerActor {
  tenantId: string
  dealerId: string
  dealerUserId: string
  email: string
  dealerRole: DealerRole
}

export interface DealerAuditActor {
  type: "dealer"
  dealerId: string
  dealerUserId: string
}

/** The audit columns for a dealer user's action; spread `actor` into newValue. */
export function dealerAuditFields(actor: Pick<DealerActor, "dealerId" | "dealerUserId" | "email">): {
  userId: undefined
  userEmail: string
  actor: DealerAuditActor
} {
  return {
    userId: undefined,
    userEmail: actor.email,
    actor: { type: "dealer", dealerId: actor.dealerId, dealerUserId: actor.dealerUserId },
  }
}

/** A staff member acting on dealer rows (lib/dealer staff-side functions). */
export interface StaffActor {
  tenantId: string
  userId: string
  userEmail?: string
}
