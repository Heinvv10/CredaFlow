/**
 * The body the reconcile screen sends, and how it reads a refusal.
 *
 * Pure and separate from the component for one reason: this is the loop that
 * releases money the server has refused. `PaymentsClient` submits from an
 * `onClick`, not a `<form>`, so a static render cannot drive it — and when
 * these rules lived inline, deleting any of them left the whole suite green
 * while unapplied money became permanently undischargeable.
 */
export type ReconciliationAction = "allocate" | "record_refund"

export interface ReconcileBody {
  action: ReconciliationAction
  reason: string
  reference: string
  valueDateOverrideReason?: string
}

export function reconcileBody(args: {
  action: ReconciliationAction
  reason: string
  reference: string
  valueDateOverrideReason: string
}): ReconcileBody {
  const body: ReconcileBody = {
    action: args.action,
    reason: args.reason,
    reference: args.reference,
  }
  const override = args.valueDateOverrideReason.trim()
  // Withheld on a refund: a refund rebates no interest, so the route ignores
  // it and a typed authorisation would vanish with no trace. Not sending it
  // keeps the request honest about what is being authorised.
  if (override && args.action === "allocate") {
    body.valueDateOverrideReason = override
  }
  return body
}

/**
 * Whether a refusal is one the admin can clear by recording a reason.
 *
 * Read from an explicit flag rather than by matching the message text — the
 * message is prose that will be reworded, and getting this wrong means the
 * override field never opens and the receipt can never be discharged.
 */
export function requiresOverride(data: {
  requiresValueDateOverride?: boolean
}): boolean {
  return data.requiresValueDateOverride === true
}
