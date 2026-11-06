import { Header } from "@/components/layout/Header"
import { auth } from "@/lib/auth"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { paybillSimulationOffered } from "@/lib/mobile-money/config"
import { canActOnPaymentNotifications } from "@/lib/payments/payment-notifications"
import { listMobileMoneyForReview } from "@/lib/mobile-money/review"
import { MobileMoneyReview } from "@/components/payments/MobileMoneyReview"
import { SimulatePaybillForm } from "@/components/payments/SimulatePaybillForm"

// M-Pesa money the ingest could not book (lib/mobile-money/review.ts), and on
// a demo stack that permits simulated-mpesa, "Simulate paybill payment".
export default async function MobileMoneyPage() {
  await requireMinRole("COLLECTIONS_AGENT")
  const rows = await listMobileMoneyForReview(await getStaffTenantId())
  // The allocate/reject route's rule: nobody is offered an action that 403s.
  const canAct = canActOnPaymentNotifications((await auth())?.user?.role)
  const simulate = canAct && paybillSimulationOffered()
  return (
    <>
      <Header title="M-Pesa" subtitle="Paybill and STK push payments waiting for a person" />
      <div className="p-4 lg:p-8 space-y-6">
        {simulate && <SimulatePaybillForm />}
        <MobileMoneyReview items={JSON.parse(JSON.stringify(rows))} canAct={canAct} />
      </div>
    </>
  )
}
