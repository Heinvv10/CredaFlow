import { redirect } from "next/navigation"
import { Building2, Mail, Phone } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { formatZAR } from "@/lib/utils"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import { StitchPaymentForm } from "@/components/portal/StitchPaymentForm"
import { ManualPaymentForm } from "@/components/portal/ManualPaymentForm"
import { CopyReferenceButton } from "@/components/portal/CopyReferenceButton"
import type { LoanOption } from "@/components/portal/StitchPaymentForm"
import { stitchConfigured } from "@/lib/stitch"
import { portalLoanCharges } from "@/lib/portal/loan-charges"
import { getT } from "@/lib/i18n/server"
import type { Translator } from "@/lib/i18n/translate"

export const metadata = {
  title: "Make a Payment",
}

async function getLoansForClient(email: string): Promise<LoanOption[]> {
  const tenantId = await getPortalTenantId()

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
    // The settlement figure is read whole (portalLoanCharges below), not from
    // this one-row slice of the schedule.
    orderBy: { createdAt: "desc" },
  })

  const asOf = new Date()
  return await Promise.all(loans.map(async (l) => {
    // Default charges are due now, on top of the schedule (0 while off).
    const charges = await portalLoanCharges(tenantId, l.id, asOf)
    const nextInstallment = l.repaymentSchedule[0]
      ? l.repaymentSchedule[0].totalDue - l.repaymentSchedule[0].totalPaid + charges.outstanding
      : null
    // s125: the same figure as the staff loan page and the certificate of balance.
    const settlementAmount = charges.totalToSettle
    return {
      id: l.id,
      reference: l.reference,
      outstandingPrincipal: l.outstandingPrincipal,
      nextInstallment,
      settlementAmount,
      // A lease's figure is the rentals outstanding, not a settlement (lib/asset-finance/lease-ledger.ts).
      lease: l.contractType === "OPERATING_LEASE" || l.contractType === "FULL_MAINTENANCE_LEASE",
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
function eftBankRows(t: Translator<"portalPayment">) {
  const accountName = process.env.STITCH_BENEFICIARY_NAME?.trim()
  const bank = process.env.STITCH_BANK_NAME?.trim()
  const accountNumber = process.env.STITCH_ACCOUNT_NUMBER?.trim()
  const branchCode = process.env.STITCH_BRANCH_CODE?.trim()
  const accountType = process.env.STITCH_ACCOUNT_TYPE?.trim()
  if (!accountName || !bank || !accountNumber || !branchCode || !accountType) return []
  return [
    { label: t("bank"), value: bank },
    { label: t("accountName"), value: accountName },
    { label: t("accountNumber"), value: accountNumber },
    { label: t("branchCode"), value: branchCode },
    { label: t("accountType"), value: accountType },
  ]
}

export default async function PaymentPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const loans = await getLoansForClient(session.user.email)
  // Same tenant source as the page's own data above, so the contact
  // details and account name always belong to the lender whose loans are shown.
  const tenantId = await getPortalTenantId()
  const identity = await getLenderIdentity(tenantId)
  // A lender without a Stitch account gets no "Pay with Stitch" form: offering
  // it only to fail with "temporarily unavailable" on click misleads the borrower.
  const onlinePayment = await stitchConfigured(tenantId)
  const t = await getT("portalPayment")
  const bankRows = eftBankRows(t)

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-6 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-6 text-[var(--cf-text)]">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-gray-400 text-sm mt-1">{t("portalOf", { brand: identity.tradingName })}</p>
      </div>

      {/* Payment reference — the loan reference the client MUST quote so the
          bank-sync reconciler can allocate the deposit to the right loan. Shown
          whether or not the bank panel below is configured. */}
      {loans.length > 0 && (
        <div className="mb-5 rounded-lg border p-5" style={{ borderColor: "#4F46E5", backgroundColor: "#4F46E514" }}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--cf-text-muted)] mb-3">
            {loans.length > 1 ? t("yourReferences") : t("yourReference")}
          </p>
          <div className="space-y-2">
            {loans.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono text-xl font-bold tracking-wide text-[var(--cf-text)]">{l.reference}</span>
                <div className="flex items-center gap-3">
                  {loans.length > 1 && (
                    <span className="text-[11px] text-[var(--cf-text-muted)]">
                      {t(l.lease ? "settlementSuffixLease" : "settlementSuffix", { amount: formatZAR(l.settlementAmount) })}
                    </span>
                  )}
                  <CopyReferenceButton reference={l.reference} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--cf-text-muted)]">{t("referenceQuote")}</p>
        </div>
      )}

      {/* Stitch online payment */}
      {onlinePayment && <StitchPaymentForm loans={loans} />}

      {/* Manual EFT payment notification */}
      {loans.length > 0 && (
        <ManualPaymentForm loans={loans} />
      )}

      {/* Contact */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 mb-5">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-4">{t("contactToPay")}</p>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Phone className="h-4 w-4 shrink-0" style={{ color: "#4F46E5" }} />
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">{t("phoneWhatsapp")}</p>
              <a href={`tel:${identity.publicPhoneE164}`} className="font-semibold text-gray-800 hover:underline">
                {identity.publicPhone}
              </a>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 shrink-0" style={{ color: "#4F46E5" }} />
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide">{t("email")}</p>
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
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{t("bankDetails")}</p>
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

          <p className="text-[11px] text-gray-400 mt-4">
            {t("referenceNote")}
          </p>
        </div>
      )}
    </div>
  )
}
