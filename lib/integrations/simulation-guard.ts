/**
 * Shared runtime safety for provider dry-run / simulation modes.
 *
 * Every integration here supports a `<PROVIDER>_DRY_RUN=true` short-circuit that
 * returns a synthetic result without spending a billable call. That is useful in
 * local dev and unit tests. It is dangerous on a deployed build, because the
 * synthetic result is a *success*: enabling the flag in production silently
 * converts "we could not reach the provider" into "the provider said yes".
 *
 * Two separate defences, because they fix two different problems:
 *
 *  1. LABEL IT — `simulated: true` on the returned payload, so a caller and the
 *     UI can tell a synthetic success from a real one. `lib/integrations/
 *     simulation-presentation.ts` already branches on exactly this field:
 *     without it, Settings -> Integrations renders a green "Connection
 *     successful" for a call that never left the process.
 *
 *  2. FORBID IT — for providers whose synthetic result is a *financial or credit
 *     outcome*, simulation is never legitimate on a deployed build. Those fail
 *     closed here rather than fabricating an approval or a disbursement.
 *
 * This generalises the guard that previously lived only in
 * `smileidentity.ts` (`assertSmileIdentityRuntimeSafety`), which was the only
 * one of six integrations that failed closed.
 *
 * NOT applied to BulkSMS deliberately — see `SIMULATION_POLICY` below.
 */

/**
 * `NODE_ENV` is "production" on every deployed build, staging included — Next.js
 * has no built-in staging distinction. So this gates out local dev (where a
 * DRY_RUN flag is expected and harmless) without pretending staging is safe.
 */
export function isDeployedBuild(): boolean {
  return process.env.NODE_ENV === "production"
}

/**
 * Providers whose dry-run fabricates a financial or credit OUTCOME. Simulation
 * for these is never legitimate on a deployed build: the synthetic value feeds
 * a lending decision or asserts that money moved.
 *
 * BulkSMS is deliberately absent. Its simulation is a supported operating mode
 * (a deployment may run `BULKSMS_DRY_RUN=true`) and it is modelled honestly
 * end-to-end: status `SIMULATED` not `SENT`, dispatch state `SIMULATED` not
 * `ACCEPTED`, audit action `MESSAGE_SIMULATED`, and an amber "Simulated — not
 * sent" in the UI. Nothing is fabricated, so there is nothing to forbid —
 * gating it would break messaging for no safety gain.
 */
const SIMULATION_FORBIDDEN_ON_DEPLOYED = {
  experian: {
    /** Experian's own sandbox signal. `UAT` is the non-production estate. */
    sandboxEnvVar: "EXPERIAN_ENV",
    sandboxSafeValues: ["UAT", "uat", "test"],
  },
  smileidentity: {
    sandboxEnvVar: "SMILE_IDENTITY_ENV",
    sandboxSafeValues: ["test"],
    /**
     * Smile's guard predates this module and its exact wording is asserted by
     * `smileidentity.test.ts`. Preserved verbatim so lifting the policy here is
     * a behaviour-preserving refactor — the tests stay a real check on the
     * guard rather than being rewritten to match whatever it now says.
     */
    legacyMessage: "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
  },
  transunion: {
    /** No provider-specific sandbox signal exists; opt-in only. */
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
  netcash: {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
  "netcash-collections": {
    sandboxEnvVar: null,
    sandboxSafeValues: [],
  },
} as const

export type GuardedIntegration = keyof typeof SIMULATION_FORBIDDEN_ON_DEPLOYED

/**
 * Escape hatch for a deployed environment that genuinely needs a simulated
 * provider — a staging box with no vendor sandbox account, for example.
 *
 * Comma-separated integration keys, e.g.
 *   SIMULATED_INTEGRATIONS=transunion,netcash
 *
 * Deliberately an ALLOW-LIST and not a boolean: a single `SIMULATE=1` would let
 * one forgotten variable disable every guard at once. Naming each provider
 * means the blast radius of a mistake is one provider, and the intent is
 * legible in the environment rather than inferred.
 */
function explicitlyAllowed(integration: GuardedIntegration): boolean {
  // A provider carrying its own vendor-sandbox rule is NOT opt-in-able. Smile is
  // the KYC source of truth and its prior guard threw unconditionally whenever
  // SMILE_IDENTITY_ENV was not "test"; letting the generic list satisfy it would
  // widen that boundary rather than preserve it — a regression the
  // refactor must not introduce. For those providers the vendor
  // signal is the ONLY route to simulation.
  if (SIMULATION_FORBIDDEN_ON_DEPLOYED[integration].sandboxEnvVar) return false

  const raw = process.env.SIMULATED_INTEGRATIONS
  if (!raw) return false
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(integration)
}

function inVendorSandbox(integration: GuardedIntegration): boolean {
  const rule = SIMULATION_FORBIDDEN_ON_DEPLOYED[integration]
  if (!rule.sandboxEnvVar) return false
  const value = process.env[rule.sandboxEnvVar]
  if (!value) return false
  return (rule.sandboxSafeValues as readonly string[]).includes(value)
}

/**
 * Throws if `<PROVIDER>_DRY_RUN` is enabled on a deployed build without an
 * explicit, known-safe signal.
 *
 * Fails closed on purpose: an unset, misspelled or unexpected sandbox value is
 * treated as production. A go-live deploy that forgets to clear the flag must
 * be caught, not silently allowed to fabricate a credit score or a payout.
 *
 * Call this at INVOCATION time, not module load — a throw at import time would
 * take down every route that transitively imports the provider, turning a
 * configuration mistake into an outage.
 */
export function assertSimulationAllowed(
  integration: GuardedIntegration,
  dryRunRequested: boolean,
): void {
  if (!dryRunRequested) return
  if (!isDeployedBuild()) return
  if (inVendorSandbox(integration) || explicitlyAllowed(integration)) return

  const rule = SIMULATION_FORBIDDEN_ON_DEPLOYED[integration] as {
    sandboxEnvVar: string | null
    sandboxSafeValues: readonly string[]
    legacyMessage?: string
  }
  if (rule.legacyMessage) throw new Error(rule.legacyMessage)

  const remedy = rule.sandboxEnvVar
    ? `set ${rule.sandboxEnvVar} to a sandbox value (${rule.sandboxSafeValues.join(" | ")})`
    : `add "${integration}" to SIMULATED_INTEGRATIONS`
  throw new Error(
    `Simulated ${integration} results are not permitted on a deployed build. ` +
      `Either clear the dry-run flag so the real provider is called, or ${remedy} ` +
      `to declare this environment non-production.`,
  )
}
