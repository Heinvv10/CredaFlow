import { isDemoMode } from "@/lib/config/demo-mode"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { findMobileMoneyProvider, mobileMoneyProviderRefusal, STK_PUSH_PROVIDER_ID } from "./registry"

/**
 * The lender's M-Pesa paybill number (MPESA_PAYBILL_SHORTCODE), or null. The
 * portal shows the M-Pesa panel only when it is set: never a placeholder a
 * borrower could pay into.
 */
export function mpesaPaybill(): string | null {
  const value = process.env.MPESA_PAYBILL_SHORTCODE?.trim()
  return value && /^\d{4,8}$/.test(value) ? value : null
}

/** "Pay with M-Pesa" is offered only where the paybill is set and the push provider may run here. */
export function stkPushAvailable(): boolean {
  const provider = findMobileMoneyProvider(STK_PUSH_PROVIDER_ID)
  return mpesaPaybill() !== null && provider !== null && mobileMoneyProviderRefusal(provider) === null
}

/**
 * "Simulate paybill payment" books a receipt for money that never moved, on any
 * loan staff name. Only a demo stack (DEMO_MODE=true) that also permits the
 * simulated provider offers it: a staging box with real loans and
 * SIMULATED_INTEGRATIONS set still does not.
 */
export function paybillSimulationOffered(): boolean {
  return isDemoMode() && isSimulationPermitted("simulated-mpesa")
}
