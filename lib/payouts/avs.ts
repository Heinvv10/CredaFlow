/**
 * The AVS a provider payout needs (decision 2026-10-14): with
 * payoutsEngineEnabled on, the payout account must have a passing,
 * application-bound AVS check for the current subject and account, whatever
 * collectionsEngineEnabled says. Checked inside the disburse transaction,
 * before the payout row is created, with the same rule as the collections
 * gate (lib/avs.ts evaluateAvsGate).
 *
 * A simulated AVS pass (a dry-run provider, persisted with raw "dry-run") is
 * accepted only where that provider's simulation is permitted
 * (lib/integrations/simulation-guard.ts), so never on a deployed build unless
 * the environment declares it. There is no AVS override path in the system;
 * the bank-detail override is already refused by the disburse route.
 */
import type { prisma } from "@/lib/prisma"
import { evaluateAvsGate } from "@/lib/avs"
import type { AvsSubjectClient } from "@/lib/compliance/avs-subject"
import { isDeployedBuild, isSimulationPermitted, type GuardedIntegration } from "@/lib/integrations/simulation-guard"

export class PayoutAvsError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "PayoutAvsError"
  }
}

/** AvsCheck.provider -> the simulation-guard key of that provider's AVS dry-run. */
const AVS_SIMULATION_KEY: Record<string, GuardedIntegration> = {
  netcash: "netcash-collections",
}

/** The marker the AVS dry-run persists (lib/integrations/collections/netcash.ts DRY_RUN_PASS). */
export function isSimulatedAvs(row: { raw: unknown }): boolean {
  return row.raw === "dry-run"
}

function simulationPermitted(provider: string): boolean {
  const key = AVS_SIMULATION_KEY[provider]
  return key ? isSimulationPermitted(key) : !isDeployedBuild()
}

export async function assertPayoutAvs(
  db: Pick<typeof prisma, "avsCheck">,
  args: {
    tenantId: string
    applicationId: string
    client: Omit<AvsSubjectClient, "bankName" | "bankAccountNumber" | "bankBranchCode" | "accountType">
    /** The account the payout goes to: the locked, verified banking details. */
    account: { bankName: string | null; bankAccountNumber: string | null; bankBranchCode: string | null; accountType: string | null }
  },
): Promise<{ avsCheckId: string; simulated: boolean }> {
  const latest = await db.avsCheck.findFirst({
    where: { tenantId: args.tenantId, clientId: args.client.id, applicationId: args.applicationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, clientId: true, applicationId: true, subjectFingerprint: true, passed: true, provider: true, raw: true },
  })
  const gate = evaluateAvsGate(latest, { ...args.client, ...args.account }, args.applicationId)
  if (!gate.ok || !latest) throw new PayoutAvsError(gate.reason ?? "No AVS check on record for this account")
  const simulated = isSimulatedAvs(latest)
  if (simulated && !simulationPermitted(latest.provider)) {
    throw new PayoutAvsError("The AVS pass on record is simulated; a provider payout needs a real AVS check of the payout account")
  }
  return { avsCheckId: latest.id, simulated }
}
