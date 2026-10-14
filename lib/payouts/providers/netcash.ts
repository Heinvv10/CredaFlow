/**
 * Netcash behind the PayoutProvider interface: a thin wrapper over the
 * existing `disburseFunds` (lib/integrations/netcash.ts), whose wire format
 * and dry-run behaviour are unchanged. Under NETCASH_DRY_RUN (or in tests) it
 * answers with a simulated acceptance, which this adapter records as
 * `simulated`; the simulation guard still forbids that on a deployed build.
 *
 * `disburseFunds` folds every failure into `{ ok: false }`. Only the
 * not-configured answer is known to have sent nothing; any other failure
 * (network error, an answer it could not read) may have reached Netcash, so it
 * is an unknown outcome for a person to resolve. Netcash offers no status
 * query or webhook through this client: an accepted payout stays SUBMITTED
 * until a person confirms it.
 */
import { disburseFunds } from "@/lib/integrations/netcash"
import type { PayoutProvider } from "../types"

export const netcashPayouts: PayoutProvider = {
  id: "netcash",
  displayName: "Netcash EFT",
  capabilities: { implemented: true, statusQuery: false, webhooks: false },

  async initiatePayout(request) {
    const result = await disburseFunds({
      tenantId: request.tenantId,
      accountHolder: request.beneficiary.accountHolder,
      accountNumber: request.beneficiary.accountNumber,
      bankCode: request.beneficiary.branchCode,
      amount: request.amountCents / 100,
      reference: request.reference,
      description: `Loan payout ${request.reference}`,
    })
    if (result.ok) {
      return result.simulated
        ? { kind: "accepted", state: "SUBMITTED", providerReference: `dry-run-${request.idempotencyKey}`, simulated: true }
        : { kind: "accepted", state: "SUBMITTED", providerReference: result.transactionId ?? "unreferenced" }
    }
    if (result.notSent) return { kind: "rejected", reason: result.error ?? "Netcash not configured" }
    return { kind: "unknown", reason: result.error ?? "Netcash gave no usable answer" }
  },

  async getPayoutStatus() {
    return { kind: "unsupported" }
  },
}
