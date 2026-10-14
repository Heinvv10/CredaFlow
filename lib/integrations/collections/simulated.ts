/**
 * Simulated collection rail: a CollectionProvider that never leaves the
 * process. For local development, tests and the demo stacks only.
 *
 * Every method calls assertSimulationAllowed at invocation time, so a deployed
 * build refuses it unless SIMULATED_INTEGRATIONS names "simulated-collections".
 * Every result carries `simulated: true`, and the engine persists that flag on
 * the mandate, batch and result rows it writes.
 *
 * Deterministic and stateless: outcomes come from the fixtures in
 * __fixtures__/simulated-scenarios.ts, keyed on the request itself. The mandate
 * reference encodes the authorisation outcome, so getMandateStatus needs no
 * memory of createMandate.
 */
import { createHash } from "node:crypto"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import {
  AVS_FAIL_ACCOUNT_SUFFIX,
  COLLECTION_OUTCOME_BY_CENTS,
  MANDATE_AUTH_BY_ACCOUNT_SUFFIX,
} from "./__fixtures__/simulated-scenarios"
import {
  CollectionProviderError,
  type AvsRequest,
  type AvsResult,
  type AwaitingInstruction,
  type CollectionInstructionInput,
  type CollectionOutcome,
  type CollectionProvider,
  type CreateMandateReq,
  type MandateHandle,
  type MandateStatusValue,
  type SubmitResult,
} from "./types"

export const SIMULATED_PROVIDER_ID = "simulated"

const guard = () => assertSimulationAllowed("simulated-collections", true)

const AUTH_CODE: Record<"AUTHENTICATED" | "REJECTED" | "EXPIRED", string> = {
  AUTHENTICATED: "A",
  REJECTED: "R",
  EXPIRED: "E",
}

function authOutcome(accountNumber: string): "AUTHENTICATED" | "REJECTED" | "EXPIRED" {
  const scripted = MANDATE_AUTH_BY_ACCOUNT_SUFFIX[accountNumber.slice(-4)]
  return scripted === "REJECTED" || scripted === "EXPIRED" ? scripted : "AUTHENTICATED"
}

async function verifyAccount(req: AvsRequest): Promise<AvsResult> {
  guard()
  const ok = !req.accountNumber.endsWith(AVS_FAIL_ACCOUNT_SUFFIX)
  return {
    passed: ok,
    simulated: true,
    checks: { accountActive: ok, acceptsDebits: ok, idNumberMatch: ok, lastNameMatch: ok, openThreeMonths: ok },
    raw: { simulated: true },
  }
}

async function createMandate(req: CreateMandateReq): Promise<MandateHandle> {
  guard()
  const outcome = authOutcome(req.account.accountNumber)
  // The debtor answers asynchronously; the answer is read back through
  // getMandateStatus, exactly as on a real rail.
  return { providerMandateRef: `SIM-${AUTH_CODE[outcome]}-${req.mandateReference}`, status: "PENDING_AUTH", simulated: true }
}

async function getMandateStatus(providerMandateRef: string): Promise<MandateStatusValue> {
  guard()
  const code = /^SIM-([ARE])-/.exec(providerMandateRef)?.[1]
  if (!code) throw new CollectionProviderError("PROVIDER_ERROR", "Not a simulated mandate reference")
  return code === "R" ? "REJECTED" : code === "E" ? "EXPIRED" : "AUTHENTICATED"
}

async function cancelMandate(providerMandateRef: string): Promise<void> {
  guard()
  if (!providerMandateRef.startsWith("SIM-")) {
    throw new CollectionProviderError("PROVIDER_ERROR", "Not a simulated mandate reference")
  }
}

async function collect(batch: CollectionInstructionInput[]): Promise<SubmitResult> {
  guard()
  const refs = batch.map((i) => i.instructionRef).sort()
  const batchRef = `SIM-B-${createHash("sha256").update(refs.join("|")).digest("hex").slice(0, 20)}`
  const accepted: string[] = []
  const rejected: SubmitResult["rejected"] = []
  for (const i of batch) {
    if (!i.mandateRef.startsWith("SIM-")) rejected.push({ instructionRef: i.instructionRef, error: "Unknown mandate" })
    else accepted.push(i.instructionRef)
  }
  return { batchRef, accepted, rejected, simulated: true }
}

function outcomeFor(i: AwaitingInstruction): CollectionOutcome | null {
  const scripted = COLLECTION_OUTCOME_BY_CENTS[i.amountCents % 100] ?? { status: "PAID" as const }
  if (scripted.status === "PENDING") return null
  const base = {
    instructionRef: i.instructionRef,
    resolvedAt: i.actionDate,
    simulated: true as const,
    raw: { simulated: true, instructionRef: i.instructionRef, scenario: scripted },
  }
  return scripted.status === "PAID"
    ? { ...base, status: "PAID", reason: null, rawCode: "SIM-PAID", settledAmountCents: i.amountCents }
    : { ...base, status: scripted.status, reason: scripted.reason, rawCode: scripted.rawCode, settledAmountCents: null }
}

async function fetchResults(window: { from: Date; awaiting?: AwaitingInstruction[] }): Promise<CollectionOutcome[]> {
  guard()
  const now = Date.now()
  return (window.awaiting ?? [])
    .filter((i) => i.actionDate.getTime() <= now && i.actionDate.getTime() >= window.from.getTime())
    .map(outcomeFor)
    .filter((o): o is CollectionOutcome => o !== null)
}

export const simulatedCollections: CollectionProvider = {
  id: SIMULATED_PROVIDER_ID,
  verifyAccount,
  createMandate,
  getMandateStatus,
  cancelMandate,
  collect,
  fetchResults,
}
