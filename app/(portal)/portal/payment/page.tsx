import { redirect } from "next/navigation"
import { Building2, Mail, Phone } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatZAR } from "@/lib/utils"
import { getDefaultTenantId } from "@/lib/tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import { StitchPaymentForm } from "@/components/portal/StitchPaymentForm"
import { ManualPaymentForm } from "@/components/portal/ManualPaymentForm"
import type { LoanOption } from "@/components/portal/StitchPaymentForm"
import { currentSettlementAmount } from "@/lib/loan/settlement"
import { portalLoanCharges } from "@/lib/portal/loan-charges"

export const metadata = {
  title: "Make a Payment",
}

async function getLoansForClient(email: string): Promise<LoanOption[]> {
  const tenantId = await getDefaultTenantId()

  const client = await prisma.client.findFirst({
    where: { email, tenantId },
    select: { id: true },
  })
  if (!client) return []

  const loans = await prisma.loan.findMany({
    // Every status a receipt can be booked against (the Stitch webhook and
    // lib/loan/apply-payment.ts): a client in default must be able to pay.
    where: { clientId: client.id, tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } },
    include: {
      repaymentSchedule: {
        where: { status: { in: ["PENDING", "PARTIAL", "OVERDUE"] } },
        orderBy: { installmentNo: "asc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  })

  const asOf = new Date()
  return await Promise.all(loans.map(async (l) => {
    // Default charges are due now, on top of the schedule (0 while off).
    const charges = await portalLoanCharges(tenantId, l.id, asOf)
    const nextInstallment = l.repaymentSchedule[0]
      ? l.repaymentSchedule[0].totalDue - l.repaymentSchedule[0].totalPaid + charges.outstanding
      : null
    const settlementAmount = currentSettlementAmount({
      loan: l,
      schedule: l.repaymentSchedule,
      asOf,
      chargesOutstanding: charges.outstanding,
    })
    return {
      id: l.id,
      reference: l.reference,
      outstandingPrincipal: l.outstandingPrincipal,
      nextInstallment,
      settlementAmount,
      chargeLines: charges.lines,
      paymentDefault: l.interestModel === "DAILY_ACCRUAL"
        ? settlementAmount
        : (nextInstallment ?? settlementAmount),
    }
  }))
}

// Bank-transfer details are shown only when ALL of STITCH_BENEFICIARY_NAME,
// STITCH_BANK_NAME, STITCH_ACCOUNT_NUMBER, STITCH_BRANCH_CODE and
// STITCH_ACCOUNT_TYPE are configured. The account name comes from the same env
// block Stitch pays into (lib/stitch.ts), so the panel cannot name a different
// account holder. We deliberately do NOT fall back to a placeholder — a client
// could otherwise transcribe and pay a non-payable account number.
// When any is unset, the whole EFT panel is hidden.
function eftBankRows() {
  const accountName = process.env.STITCH_BENEFICIARY_NAME?.trim()
  const bank = process.env.STITCH_BANK_NAME?.trim()
  const accountNumber = process.env.STITCH_ACCOUNT_NUMBER?.trim()
  const branchCode = process.env.STITCH_BRANCH_CODE?.trim()
  const accountType = process.env.STITCH_ACCOUNT_TYPE?.trim()
  if (!accountName || !bank || !accountNumber || !branchCode || !accountType) return []
  return [
    { label: "Bank", value: bank },
    { label: "Account Name", value: accountName },
    { label: "Account Number", value: accountNumber },
    { label: "Branch Code", value: branchCode },
    { label: "Account Type", value: accountType },
  ]
}

export default async function PaymentPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const loans = await getLoansForClient(session.user.email)
  // Same tenant source as the page's own data above, so the contact
  // details and account name always belong to the lender whose loans are shown.
  const identity = await getLenderIdentity(await getDefaultTenantId())
  const bankRows = eftBankRows()

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-6 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-6 text-[var(--cf-text)]">
        <h1 className="text-2xl font-bold">Make a Payment</h1>
        <p className="text-gray-400 text-sm mt-1">{identity.tradingName} Client Portal</p>
      </div>

      {/* Stitch online payment */}
      <StitchPaymentForm loans={loans} />

      {/* Manual EFT payment notification */}
      {loans.length > 0 && (
        <ManualPaymentForm loans={loans} />
      )}

      {/* Contact */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-4">Contact Us to Pay</p>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Phone className="h-4 w-4 shrink-0" style={{ color: "#4F46E5" }} />
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">Phone / WhatsApp</p>
              <a href={`tel:${identity.publicPhoneE164}`} className="font-semibold text-gray-800 hover:underline">
                {identity.publicPhone}
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 shrink-0" style={{ color: "#4F46E5" }} />
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">Email</p>
              <a href={`mailto:${identity.publicEmail}`} className="font-semibold text-gray-800 hover:underline">
                {identity.publicEmail}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* EFT bank transfer alternative — only when every bank detail is configured */}
      {bankRows.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6">
          <div className="flex items-center gap-2 mb-4">
            <Building2 className="h-4 w-4" style={{ color: "#4F46E5" }} />
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Bank Transfer Details</p>
          </div>
          <div className="space-y-3 text-sm">
            {bankRows.map(({ label, value }) => (
              <div
                key={label}
                className="flex justify-between items-center py-2 border-b border-gray-50 last:border-0"
              >
                <span className="text-gray-500">{label}</span>
                <span className="font-semibold text-gray-800">{value}</span>
              </div>
            ))}
          </div>

          {/* Payment reference — the loan reference the client MUST quote so the
              bank-sync reconciler can allocate the deposit to the right loan. */}
          {loans.length > 0 && (
            <div className="mt-4 rounded-md border p-3" style={{ borderColor: "#4F46E5", backgroundColor: "#4F46E514" }}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
                Payment Reference{loans.length > 1 ? "s" : ""}
              </p>
              <div className="space-y-1">
                {loans.map((l) => (
                  <div key={l.id} className="flex justify-between items-center gap-3">
                    <span className="font-mono font-bold text-sm" style={{ color: "#4F46E5" }}>{l.reference}</span>
                    {loans.length > 1 && (
                      <span className="text-[11px] text-gray-400">{formatZAR(l.settlementAmount)} settlement</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] text-gray-400 mt-4">
            Always use your loan reference above as the payment reference so your payment can be allocated correctly.
            Payments made without the correct reference may take longer to reflect.
          </p>
        </div>
      )}
    </div>
  )
}
