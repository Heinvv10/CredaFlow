import Link from "next/link"
import { hasMinRole } from "@/lib/permissions"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { ClientForm } from "@/components/clients/ClientFormLegacy"
import { getStaffTenantId } from "@/lib/session-tenant"
import { auth } from "@/lib/auth"
import { requireLoanBookPage } from "@/lib/auth-guards"
import { canReassignReferralAgent } from "@/lib/clients/referral-update"

async function getClient(id: string, tenantId: string) {
  return prisma.client.findUnique({
    where: { id, tenantId },
    include: {
      expenseBreakdown: true,
      debtObligations: true,
      // Named so a since-retired code shows as an agent rather than a bare id.
      referralCode: {
        select: { code: true, agent: { select: { displayName: true } } },
      },
    },
  })
}

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // The form carries the client's income, expenses, expense breakdown and
  // declared debt, the affordability evidence: a role without the loan book
  // (INSURANCE_OFFICER, which cannot save it either) does not open it.
  await requireLoanBookPage()
  const { id } = await params
  const session = await auth()
  if (!session?.user?.role || session.user.role === "CLIENT" || !hasMinRole(session.user.role, "CREDIT_OFFICER")) {
    return <div className="p-6 space-y-3"><h1 className="text-xl font-semibold">Client record is read-only</h1><p>Your role can view client records. Editing requires a credit officer or a role with higher permissions.</p><Link href={`/clients/${id}`} className="underline">Return to client</Link></div>
  }
  const tenantId = await getStaffTenantId()
  const client = await getClient(id, tenantId)
  if (!client) notFound()

  // Mirror the API's floor for re-pointing referral commission, so lower roles
  // get a read-only field instead of a form that 403s on save.
  const canEditReferralAgent = canReassignReferralAgent(session?.user?.role)
  const referralAgentName = client.referralCode
    ? [client.referralCode.agent?.displayName, client.referralCode.code]
        .filter(Boolean)
        .join(" — ")
    : null

  const initialData = {
    id: client.id,
    updatedAt: client.updatedAt.toISOString(),
    firstName: client.firstName,
    lastName: client.lastName,
    idNumber: client.idNumber,
    dateOfBirth: client.dateOfBirth?.toISOString().split("T")[0],
    gender: client.gender ?? undefined,
    email: client.email,
    phone: client.phone,
    whatsapp: client.whatsapp ?? undefined,
    addressLine1: client.addressLine1 ?? undefined,
    suburb: client.suburb ?? undefined,
    city: client.city ?? undefined,
    province: client.province ?? undefined,
    postalCode: client.postalCode ?? undefined,
    employmentStatus: client.employmentStatus ?? undefined,
    employerName: client.employerName ?? undefined,
    employerAddress: client.employerAddress ?? undefined,
    employmentStartDate: client.employmentStartDate?.toISOString().split("T")[0],
    salaryPaymentDay: client.salaryPaymentDay ?? undefined,
    grossMonthlyIncome: client.grossMonthlyIncome ?? undefined,
    monthlyIncome: client.monthlyIncome,
    monthlyExpenses: client.monthlyExpenses,
    incomeSourceType: client.incomeSourceType ?? undefined,
    bankName: client.bankName ?? undefined,
    bankAccountNumber: client.bankAccountNumber ?? undefined,
    bankBranchCode: client.bankBranchCode ?? undefined,
    accountType: client.accountType ?? undefined,
    nextOfKinName: client.nextOfKinName ?? undefined,
    nextOfKinPhone: client.nextOfKinPhone ?? undefined,
    nextOfKinRelationship: client.nextOfKinRelationship ?? undefined,
    popiaConsentGiven: client.popiaConsentGiven,
    referralCodeId: client.referralCodeId,
    referralCodeLabel: referralAgentName,
    // ClientForm owns the single cents -> rands conversion for editable money.
    // Keep every amount below in raw Prisma cents to prevent a 100x reduction
    // during render followed by an invalid affordability submission.
    // Older/imported clients may have only the cached monthlyExpenses scalar.
    // Seed that amount into "other" instead of showing an all-zero breakdown;
    // otherwise a banking-only save silently overwrites R8,000 with R0.
    expenseBreakdown: client.expenseBreakdown
      ? {
          housing: client.expenseBreakdown.housing,
          transport: client.expenseBreakdown.transport,
          food: client.expenseBreakdown.food,
          education: client.expenseBreakdown.education,
          insurance: client.expenseBreakdown.insurance,
          clothing: client.expenseBreakdown.clothing,
          entertainment: client.expenseBreakdown.entertainment,
          medical: client.expenseBreakdown.medical,
          other: client.expenseBreakdown.other,
          belowMleJustification: client.expenseBreakdown.belowMleJustification ?? "",
        }
      : client.monthlyExpenses > 0
        ? {
            housing: 0,
            transport: 0,
            food: 0,
            education: 0,
            insurance: 0,
            clothing: 0,
            entertainment: 0,
            medical: 0,
            other: client.monthlyExpenses,
            belowMleJustification: "",
          }
        : undefined,
    debtObligations: client.debtObligations.map((debt) => ({
      id: debt.id,
      creditProvider: debt.creditProvider,
      accountType: debt.accountType,
      outstandingBalance: debt.outstandingBalance,
      monthlyInstalment: debt.monthlyInstalment,
      notes: debt.notes,
    })),

  }

  return (
    <>
      <Header
        title={`Edit — ${client.firstName} ${client.lastName}`}
        subtitle={client.reference}
        breadcrumbs={[
          { label: "Clients", href: "/clients" },
          { label: `${client.firstName} ${client.lastName}`, href: `/clients/${client.id}` },
          { label: "Edit" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <ClientForm initialData={initialData} canEditReferralAgent={canEditReferralAgent} />
      </div>
    </>
  )
}
