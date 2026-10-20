/**
 * Who captures a borrower, an asset or a deal: a staff member, or a dealer
 * user through the dealer portal (lib/dealer/). A dealer's rows carry
 * createdByDealerId (written once: migration 20261019120200), which a dealer
 * deal's provenance check reads (guardAssetDealDealer); its audit rows carry
 * no userId and name the dealer in newValue.actor (lib/dealer/actor.ts).
 */
import { dealerAuditFields, type DealerActor } from "@/lib/dealer/actor"

export type OriginationActor =
  | { kind: "staff"; tenantId: string; userId: string; userEmail?: string }
  | { kind: "dealer"; actor: DealerActor }

export const originationTenant = (by: OriginationActor) => (by.kind === "staff" ? by.tenantId : by.actor.tenantId)

/** createdById (a plain text column: the staff user, or the dealer user) and the dealer provenance. */
export function originationColumns(by: OriginationActor): { createdById: string; createdByDealerId?: string } {
  return by.kind === "staff" ? { createdById: by.userId } : { createdById: by.actor.dealerUserId, createdByDealerId: by.actor.dealerId }
}

/** The audit columns, and the actor to add to newValue for a dealer. */
export function originationAudit(by: OriginationActor): { userId?: string; userEmail?: string; actor?: ReturnType<typeof dealerAuditFields>["actor"] } {
  if (by.kind === "staff") return { userId: by.userId, userEmail: by.userEmail }
  const fields = dealerAuditFields(by.actor)
  return { userId: undefined, userEmail: fields.userEmail, actor: fields.actor }
}
