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
  type CollectionProvider,
  type ProviderCredentials,
} from "./types"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { openCredential } from "@/lib/integrations/tenant-credentials"
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
  // Stored sealed (lib/integrations/tenant-credentials.ts); opened only here, at use.
  const riskReportsKey = openCredential(creds.netcashRiskReportsKey)
  if (!riskReportsKey) {
    throw new CollectionProviderError(
      "NOT_CONFIGURED",
      "Netcash Risk-Reports service key missing (Settings → Integrations → Collections)"
    )
  }
  return netcashAvsQuery(req, riskReportsKey)
}

const notImplemented = (what: string) => {
  throw new CollectionProviderError("NOT_IMPLEMENTED", `netcash ${what} ships in a later slice`)
}

export const netcashCollections: CollectionProvider = {
  id: "netcash",
  verifyAccount,
  createMandate: async () => notImplemented("createMandate"),
  getMandateStatus: async () => notImplemented("getMandateStatus"),
  cancelMandate: async () => notImplemented("cancelMandate"),
  collect: async () => notImplemented("collect"),
  fetchResults: async () => notImplemented("fetchResults"),
}
