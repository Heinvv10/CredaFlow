/**
 * The simulated payout channel, for demos and tests. It moves no money, and
 * every payout it touches is recorded `simulated`. Forbidden on a deployed
 * build unless "simulated-payout" is in SIMULATED_INTEGRATIONS
 * (lib/integrations/simulation-guard.ts).
 *
 * Outcomes are chosen by the beneficiary account number's last four digits,
 * so a demo or a test can drive every path:
 *   0000 -> rejected (never sent)        9999 -> unknown outcome (timeout)
 *   1111 -> accepted, later FAILED       2222 -> accepted, later RETURNED
 *   anything else -> accepted, later PAID
 *
 * Webhooks are HMAC-SHA256 signed with SIMULATED_PAYOUT_WEBHOOK_SECRET in the
 * `x-simulated-signature` header (hex), over `<timestamp>.<raw body>`, where
 * `x-simulated-timestamp` is unix seconds and the body is
 * `{ providerReference, idempotencyKey, state, reason? }`. A notification
 * signed more than five minutes from now is refused, so a captured one cannot
 * be replayed later.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { assertSimulationAllowed, isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import type { PayoutNotification, PayoutProvider, ProviderPayoutState } from "../types"

const STATES: readonly ProviderPayoutState[] = ["SUBMITTED", "PROCESSING", "PAID", "FAILED", "RETURNED"]

function finalState(reference: string): { state: ProviderPayoutState; reason?: string } {
  const suffix = reference.slice(-4)
  if (suffix === "1111") return { state: "FAILED", reason: "Simulated: account closed" }
  if (suffix === "2222") return { state: "RETURNED", reason: "Simulated: returned by the receiving bank" }
  return { state: "PAID" }
}

export const WEBHOOK_TOLERANCE_SECONDS = 300

export function signSimulatedWebhook(rawBody: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
}

export const simulatedPayouts: PayoutProvider = {
  id: "simulated",
  displayName: "Simulated (no money moves)",
  capabilities: { implemented: true, statusQuery: true, webhooks: true },
  simulation: () => "simulated-payout",

  async initiatePayout(request) {
    assertSimulationAllowed("simulated-payout", true)
    const suffix = request.beneficiary.accountNumber.slice(-4)
    if (suffix === "0000") return { kind: "rejected", reason: "Simulated: beneficiary account refused before sending" }
    if (suffix === "9999") return { kind: "unknown", reason: "Simulated: no answer from the provider" }
    // The reference carries the account suffix so a later status query can
    // replay the scenario without any stored state.
    return { kind: "accepted", state: "SUBMITTED", providerReference: `sim-${request.idempotencyKey}-${suffix}`, simulated: true }
  },

  async getPayoutStatus({ providerReference }) {
    assertSimulationAllowed("simulated-payout", true)
    return { kind: "state", ...finalState(providerReference) }
  },

  parseWebhook({ rawBody, headers, now }): PayoutNotification | null {
    const secret = process.env.SIMULATED_PAYOUT_WEBHOOK_SECRET
    if (!secret || !isSimulationPermitted("simulated-payout")) return null
    const timestamp = Number(headers.get("x-simulated-timestamp"))
    const nowSeconds = Math.floor((now ?? new Date()).getTime() / 1000)
    if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return null
    const given = headers.get("x-simulated-signature") ?? ""
    const expected = signSimulatedWebhook(rawBody, secret, timestamp)
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return null
    }
    const { providerReference, idempotencyKey, state, reason, eventId, occurredAt } = (body ?? {}) as Record<string, unknown>
    if (!STATES.includes(state as ProviderPayoutState)) return null
    const at = typeof occurredAt === "string" ? new Date(occurredAt) : null
    return {
      // A redelivery repeats the body, so without an id of its own the body's hash is the event id.
      eventId: typeof eventId === "string" && eventId ? eventId.slice(0, 200) : createHash("sha256").update(rawBody).digest("hex"),
      occurredAt: at && !Number.isNaN(at.getTime()) ? at : null,
      providerReference: typeof providerReference === "string" ? providerReference : null,
      idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
      state: state as ProviderPayoutState,
      ...(typeof reason === "string" ? { reason } : {}),
    }
  },
}
