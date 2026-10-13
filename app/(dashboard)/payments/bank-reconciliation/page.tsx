import { Header } from "@/components/layout/Header"
import { getStaffTenantId } from "@/lib/session-tenant"
import { requireMinRole } from "@/lib/auth-guards"
import { BankReconciliationClient } from "./BankReconciliationClient"
import { StatementUpload } from "./StatementUpload"
import { getReconciliationData } from "./data"

export default async function BankReconciliationPage() {
  // Reconciliation confirms/ignores are financial actions equivalent to
  // recording a payment — gate the page at the same CREDIT_OFFICER floor as
  // the record_payment permission the server actions enforce (lib/auth-guards.ts).
  await requireMinRole("CREDIT_OFFICER")

  const { txns, candidateLoans } = await getReconciliationData(await getStaffTenantId())

  return (
    <>
      <Header
        title="Bank Reconciliation"
        subtitle="Review ABSA statement imports — confirm proposed matches or assign unmatched deposits"
      />
      <div className="p-4 lg:p-8 space-y-6">
        <StatementUpload />
        <BankReconciliationClient txns={txns} candidateLoans={candidateLoans} />
      </div>
    </>
  )
}
