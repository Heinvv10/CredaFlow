import { prisma } from "@/lib/prisma"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { getScreeningConfig, screeningCutoff } from "./policy"
import { runScreening } from "./run"
import { loadLatestRun, lockClientScreening } from "./store"
import { deriveScreeningState, screeningAllowsApproval, screeningStateMessage, type ScreeningState } from "./state"

export type ClientScreening = { state: ScreeningState; runAt: Date | null; runId: string | null }

/** The client's current screening state, read-only (no provider call). */
export async function readClientScreening(
  tenantId: string,
  clientId: string,
  db: Pick<typeof prisma, "screeningCheck" | "tenantConfig"> = prisma,
): Promise<ClientScreening> {
  const config = await getScreeningConfig(tenantId, db)
  if (!config.provider) return { state: { state: "NOT_CONFIGURED" }, runAt: null, runId: null }
  const latest = await loadLatestRun(db, tenantId, clientId)
  return {
    state: deriveScreeningState({
      configured: true,
      latestRun: latest?.checks ?? [],
      simulationPermitted: isSimulationPermitted("screening"),
    }),
    runAt: latest?.runAt ?? null,
    runId: latest?.runId ?? null,
  }
}

export type ScreeningGateResult = {
  allowed: boolean
  state: ScreeningState
  message: string
  /** The provider's error text when a run attempted here failed. */
  providerError: string | null
}

/**
 * The pre-approval screening gate. Re-screens first when the client has never
 * been screened or the latest run is older than SCREENING_MAX_AGE_DAYS, then
 * allows approval only for CLEAR (or a lender without screening). PEP and
 * possible matches refer to a reviewer; a sanctions match or a rejected match
 * blocks with no override. Disbursement uses `readClientScreening` instead:
 * it never calls the provider.
 */
export async function screeningApprovalGate(args: {
  tenantId: string
  clientId: string
  applicationId: string
  actor: { id: string; email: string }
  now?: Date
}): Promise<ScreeningGateResult> {
  const { tenantId, clientId, applicationId, actor } = args
  const current = await readClientScreening(tenantId, clientId)
  let state = current.state
  let providerError: string | null = null
  if (state.state !== "NOT_CONFIGURED" && (!current.runAt || current.runAt < screeningCutoff(args.now))) {
    const ran = await runScreening({ tenantId, clientId, trigger: "PRE_APPROVAL", applicationId, actor })
    if (ran.configured) {
      state = ran.state
      providerError = ran.providerError
    } else {
      state = { state: "NOT_CONFIGURED" }
    }
  }
  return { allowed: screeningAllowsApproval(state), state, message: screeningStateMessage(state), providerError }
}

/**
 * The same rule re-read inside the approval transaction, under the client's
 * screening lock, so a run or review committing in between is seen. The SQL
 * trigger guardLoanApplicationScreening is the backstop for other writers.
 */
export async function lockedScreeningAllowsApproval(
  tx: Pick<typeof prisma, "$executeRaw" | "screeningCheck" | "tenantConfig">,
  tenantId: string,
  clientId: string,
): Promise<boolean> {
  await lockClientScreening(tx, tenantId, clientId)
  const { state } = await readClientScreening(tenantId, clientId, tx)
  return screeningAllowsApproval(state)
}
