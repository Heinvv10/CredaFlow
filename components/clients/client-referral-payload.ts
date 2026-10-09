import type { ReferralImpactSummary } from "./ReferralAgentField"

// The referral half of the client-edit PUT body, extracted from ClientFormLegacy
// so it can be tested without rendering the form.
//
// It is here rather than inline because it carries a MONEY guard: the totals it
// forwards are what the server compares its freshly-built plan against before
// writing (app/api/clients/[id]/route.ts). Left inline it was reachable only
// through a Radix-heavy form this harness cannot render, so the one binding that
// stops an operator approving one figure and writing another had no test at all.

export type ReferralPayloadFields = {
  referralCodeId?: string | null
  referralImpact?: { totalAccrueCents: number; totalReverseCents: number }
}

/**
 * Reads the submitted form directly, so the KEY-PRESENCE contract is the real
 * one: `ReferralAgentField` renders its `<select>` only once the agent list has
 * loaded, and an absent key must mean "leave the attribution alone", never
 * "clear it". An empty VALUE is different — that is the "No referral agent"
 * option, a real instruction to clear.
 *
 * `impact` is null when there is no pending move or when the preview fetch
 * failed. The save still proceeds in that case, just unbound: the accrual is
 * computed server-side either way, and refusing an unrelated client edit over a
 * failed preview would be the worse failure.
 */
export function referralPayloadFields(
  fd: FormData,
  impact: ReferralImpactSummary | null,
): ReferralPayloadFields {
  if (!fd.has("referralCodeId")) return {}

  return {
    referralCodeId: (fd.get("referralCodeId") as string) || null,
    // Only the two figures the PUT compares. `blocked` is a UI concern and has
    // no business in a money contract.
    ...(impact && {
      referralImpact: {
        totalAccrueCents: impact.totalAccrueCents,
        totalReverseCents: impact.totalReverseCents,
      },
    }),
  }
}

/** Whether the server has refused this re-attribution outright. */
export function isReferralSaveBlocked(impact: ReferralImpactSummary | null): boolean {
  return impact?.blocked === true
}
