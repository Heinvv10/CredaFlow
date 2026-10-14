/**
 * Typed slots for payout channels a lender may choose, with no wire format
 * yet. Each must be built to its provider's published or contracted spec once
 * a lender signs up; nothing here guesses at one. The registry refuses to
 * dispatch to a provider whose `implemented` is false, and these throw if
 * called anyway.
 *
 *  - capitec-pay: Capitec Pay (Capitec Bank) — needs a merchant agreement and
 *    its API documentation, which is issued under that agreement.
 *  - payshap: PayShap (BankservAfrica / participating banks) real-time
 *    payments — reached through a sponsoring bank's or a PSP's API.
 *  - cash-voucher: a cash-out / wallet voucher issuer — provider not chosen.
 */
import { PayoutProviderError, type PayoutProvider } from "../types"

function skeleton(id: string, displayName: string, needs: string): PayoutProvider {
  const refuse = (): never => {
    throw new PayoutProviderError("NOT_IMPLEMENTED", `${displayName} payouts are not implemented yet: ${needs}`)
  }
  return {
    id,
    displayName,
    capabilities: { implemented: false, statusQuery: false, webhooks: false },
    initiatePayout: async () => refuse(),
    getPayoutStatus: async () => refuse(),
  }
}

export const capitecPayPayouts = skeleton("capitec-pay", "Capitec Pay", "needs a Capitec Pay merchant agreement and its API specification")
export const payShapPayouts = skeleton("payshap", "PayShap", "needs a sponsoring bank or PSP and its PayShap API specification")
export const cashVoucherPayouts = skeleton("cash-voucher", "Cash-out / wallet voucher", "needs a chosen voucher issuer and its API specification")
