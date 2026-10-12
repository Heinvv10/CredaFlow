/**
 * One-off lender configuration a real tenant does in Settings before lending,
 * driven through the same API (PATCH /api/settings/credit-policy, ADMIN).
 *
 * The product's default bureau floor (450) sits below the Experian Sigma
 * band (lib/integrations/experian-spec.ts), and lib/decision/bureau-gate.ts
 * deliberately blocks every approval as "not calibrated" until ops set an
 * in-band floor. Idempotent: an already-calibrated policy is left alone.
 */
import { SIGMA_SCORE_MIN } from "../../../lib/integrations/experian-spec"
import { log } from "../sim/env"
import type { OriginationContext } from "./context"

/** Acme Lending's demo cut-off: inside the Sigma band, below the simulated bureau score (645). */
export const DEMO_BUREAU_MIN_SCORE = 560

interface CreditPolicy {
  bureauMinScore: number
  bureauBlockAdverse: boolean
  ndiBufferPct: number
}

export async function ensureCreditPolicy(ctx: OriginationContext): Promise<void> {
  const current = (await ctx.admin.get<CreditPolicy>("/api/settings/credit-policy")).json
  if (!current) throw new Error("GET /api/settings/credit-policy returned no JSON")
  if (current.bureauMinScore >= SIGMA_SCORE_MIN) return
  await ctx.admin.patch("/api/settings/credit-policy", { ...current, bureauMinScore: DEMO_BUREAU_MIN_SCORE }, { expect: [200] })
  log(`credit policy calibrated: bureau minimum score ${current.bureauMinScore} → ${DEMO_BUREAU_MIN_SCORE}`)
}
