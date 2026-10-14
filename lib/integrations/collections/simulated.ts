/**
 * Simulated collection rail: a CollectionProvider that never leaves the
 * process. For local development, tests and the demo stacks only.
 *
 * Behaves like a FILE-BASED rail, so the engine's asynchronous path is the one
 * exercised: createMandate answers PENDING_REGISTRATION without a reference
 * (registration is read back through findMandate), and collect answers
 * awaitingLoadReport (the load report is read back through
 * getBatchLoadReport).
 *
 * Every method checks the simulation guard at invocation time. A refusal is a
 * CollectionProviderError NOT_CONFIGURED: nothing was sent, so the engine may
 * safely release what it claimed. Every answer carries `simulated: true`.
 *
 * Outcomes are deterministic (__fixtures__/simulated-scenarios.ts). The only
 * memory is per process (globalThis): which mandates were registered, with the
 * authorisation outcome their account scripted, and which were cancelled. A
 * restart forgets it; registration then stays pending, which the engine's
 * timeouts surface to staff.
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
  type BatchLoadReport,
  type CollectionInstructionInput,
  type CollectionOutcome,
  type CollectionProvider,
  type CreateMandateReq,
  type MandateHandle,
  type MandateStatusValue,
  type SubmitResult,
} from "./types"

export const SIMULATED_PROVIDER_ID = "simulated"

type AuthOutcome = "AUTHENTICATED" | "REJECTED" | "EXPIRED"
const AUTH_CODE: Record<AuthOutcome, string> = { AUTHENTICATED: "A", REJECTED: "R", EXPIRED: "E" }

const memory = ((globalThis as unknown as { simulatedCollections?: { registered: Map<string, AuthOutcome>; cancelled: Set<string> } })
  .simulatedCollections ??= { registered: new Map(), cancelled: new Set() })

/** Test seam: forget everything, as a process restart would. */
export function resetSimulatedRail(): void {
  memory.registered.clear()
  memory.cancelled.clear()
}

function guard(): void {
  try {
    assertSimulationAllowed("simulated-collections", true)
  } catch (error) {
    throw new CollectionProviderError("NOT_CONFIGURED", error instanceof Error ? error.message : "Simulation refused")
  }
}

function authOutcome(accountNumber: string): AuthOutcome {
  const scripted = MANDATE_AUTH_BY_ACCOUNT_SUFFIX[accountNumber.slice(-4)]
  return scripted === "REJECTED" || scripted === "EXPIRED" ? scripted : "AUTHENTICATED"
}

const refFor = (mandateReference: string, outcome: AuthOutcome) => `SIM-${AUTH_CODE[outcome]}-${mandateReference}`

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
  memory.registered.set(req.mandateReference, authOutcome(req.account.accountNumber))
  return { providerMandateRef: null, status: "PENDING_REGISTRATION", simulated: true }
}

async function findMandate(mandateReference: string): Promise<MandateHandle | null> {
  guard()
  const outcome = memory.registered.get(mandateReference)
  if (!outcome) return null
  return { providerMandateRef: refFor(mandateReference, outcome), status: "PENDING_AUTH", simulated: true }
}

async function getMandateStatus(providerMandateRef: string): Promise<MandateStatusValue> {
  guard()
  if (memory.cancelled.has(providerMandateRef)) return "CANCELLED"
  const code = /^SIM-([ARE])-/.exec(providerMandateRef)?.[1]
  if (!code) throw new CollectionProviderError("PROVIDER_ERROR", "Not a simulated mandate reference")
  return code === "R" ? "REJECTED" : code === "E" ? "EXPIRED" : "AUTHENTICATED"
}

async function cancelMandate(providerMandateRef: string): Promise<void> {
  guard()
  if (!providerMandateRef.startsWith("SIM-")) {
    throw new CollectionProviderError("PROVIDER_ERROR", "Not a simulated mandate reference")
  }
  memory.cancelled.add(providerMandateRef)
}

async function collect(batch: CollectionInstructionInput[]): Promise<SubmitResult> {
  guard()
  const refs = batch.map((i) => i.instructionRef).sort()
  const batchRef = `SIM-B-${createHash("sha256").update(refs.join("|")).digest("hex").slice(0, 20)}`
  return { batchRef, accepted: [], rejected: [], awaitingLoadReport: true, simulated: true }
}

async function getBatchLoadReport(batch: { batchRef: string; instructionRefs: string[] }): Promise<BatchLoadReport> {
  guard()
  if (!batch.batchRef.startsWith("SIM-B-")) throw new CollectionProviderError("PROVIDER_ERROR", "Not a simulated batch")
  return { state: "LOADED", accepted: [...batch.instructionRefs], rejected: [] }
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

async function fetchResults(window: { from: Date; to: Date; awaiting?: AwaitingInstruction[] }): Promise<CollectionOutcome[]> {
  guard()
  return (window.awaiting ?? [])
    .filter((i) => i.actionDate.getTime() <= window.to.getTime() && i.actionDate.getTime() >= window.from.getTime())
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
  getBatchLoadReport,
  findMandate,
}
