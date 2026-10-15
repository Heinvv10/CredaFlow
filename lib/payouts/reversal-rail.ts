/**
 * Before a reversal is approved, every attempt the provider could still have
 * paid is checked against the rail, where the rail can be asked
 * (`capabilities.statusQuery`). The provider must say FAILED or RETURNED; a
 * PAID/PROCESSING/SUBMITTED answer refuses the reversal (a PAID one is also
 * recorded as a provider conflict, lib/payouts/conflicts.ts; the others are
 * audited as stale there), and an answer that
 * cannot be had refuses it too. Attempts on rails that cannot be asked rest
 * on how they ended: a provider-reported failure, or a staff confirm_failed
 * by someone other than the disburser, with this approval as the second
 * person.
 */
import { recordProviderConflict } from "./conflicts"
import type { PayoutDb } from "./dispatch"
import { findPayoutProvider } from "./registry"

export async function railRefusal(db: PayoutDb, args: { tenantId: string; loanId: string; actor: { id: string; email: string } }): Promise<string | null> {
  const attempts = await db.disbursementPayout.findMany({
    where: { tenantId: args.tenantId, loanId: args.loanId, status: { in: ["FAILED", "RETURNED"] }, providerReference: { not: null } },
    select: { id: true, status: true, provider: true, providerReference: true, idempotencyKey: true },
  })
  for (const attempt of attempts) {
    const provider = findPayoutProvider(attempt.provider)
    if (!provider?.capabilities.statusQuery || !attempt.providerReference) continue
    let answer
    try {
      answer = await provider.getPayoutStatus({ tenantId: args.tenantId, providerReference: attempt.providerReference, idempotencyKey: attempt.idempotencyKey })
    } catch (error) {
      return `Could not confirm attempt ${attempt.id} with ${provider.displayName} (${error instanceof Error ? error.name : "error"}); try again`
    }
    if (answer.kind === "unsupported") continue
    if (answer.kind === "unknown") return `Could not confirm attempt ${attempt.id} with ${provider.displayName}: ${answer.reason}`
    if (answer.state === "FAILED" || answer.state === "RETURNED") continue
    if (attempt.status === "FAILED") {
      await recordProviderConflict(db, {
        tenantId: args.tenantId, payout: attempt, state: answer.state, reason: answer.reason, source: "status_query",
        actor: { id: args.actor.id, email: args.actor.email },
      })
    }
    return `${provider.displayName} reports attempt ${attempt.id} as ${answer.state}: the money may have reached the borrower`
  }
  return null
}
