/**
 * Netcash collection adapter — NIWS web services (SOAP 1.2).
 * Docs: https://api.netcash.co.za/ws-methods/ (public, endpoint-level).
 * Credentials (per-tenant, TenantConfig): netcashRiskReportsKey (AVS-R),
 * netcashDebitOrderKey (mandates + collections — slices 3-4).
 * Netcash-specific naming stays inside this file.
 */
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
  type ProviderCredentials,
  type SubmitResult,
} from "./types"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { netcashAvsQuery } from "./netcash-avs-wire"

function isDryRun(): boolean {
  return process.env.NODE_ENV === "test" || process.env.NETCASH_COLLECTIONS_DRY_RUN === "true"
}

// Returned by reference to every dry-run caller — frozen (incl. the nested
// `checks` object) so a mutating caller can't corrupt future dry-runs.
const DRY_RUN_PASS: AvsResult = Object.freeze({
  passed: true,
  simulated: true,
  checks: Object.freeze({
    accountActive: true,
    acceptsDebits: true,
    idNumberMatch: true,
    lastNameMatch: true,
    openThreeMonths: true,
  }),
  raw: "dry-run",
})

async function verifyAccount(req: AvsRequest, creds: ProviderCredentials): Promise<AvsResult> {
  if (isDryRun()) {
    // A fabricated AVS pass asserts the client's bank account exists, accepts
    // debits and matches their ID — the checks that gate a debit mandate.
    // Never permitted on a deployed build without an explicit declaration.
    assertSimulationAllowed("netcash-collections", true)
    return DRY_RUN_PASS
  }
  if (!creds.netcashRiskReportsKey) {
    throw new CollectionProviderError(
      "NOT_CONFIGURED",
      "Netcash Risk-Reports service key missing (Settings → Integrations → Collections)"
    )
  }
  return netcashAvsQuery(req, creds.netcashRiskReportsKey)
}

const notImplemented = (what: string): never => {
  throw new CollectionProviderError("NOT_IMPLEMENTED", `netcash ${what} ships in a later slice`)
}

// Typed against the final CollectionProvider interface so the real NIWS calls
// (debit-order key: netcashDebitOrderKey) drop in without changing a caller.
// NOT_IMPLEMENTED is a definite "nothing was sent": the engine treats it as
// safe to retry, unlike a PROVIDER_ERROR.
export const netcashCollections: CollectionProvider = {
  id: "netcash",
  verifyAccount,
  createMandate: async (_req: CreateMandateReq, _creds: ProviderCredentials): Promise<MandateHandle> =>
    notImplemented("createMandate"),
  getMandateStatus: async (_ref: string, _creds: ProviderCredentials): Promise<MandateStatusValue> =>
    notImplemented("getMandateStatus"),
  cancelMandate: async (_ref: string, _creds: ProviderCredentials): Promise<void> =>
    notImplemented("cancelMandate"),
  collect: async (_batch: CollectionInstructionInput[], _creds: ProviderCredentials): Promise<SubmitResult> =>
    notImplemented("collect"),
  fetchResults: async (
    _window: { from: Date; awaiting?: AwaitingInstruction[] },
    _creds: ProviderCredentials,
  ): Promise<CollectionOutcome[]> => notImplemented("fetchResults"),
}
