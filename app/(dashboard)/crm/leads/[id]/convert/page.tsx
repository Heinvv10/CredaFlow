import { notFound } from "next/navigation"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { ConvertLeadForm } from "@/components/crm/ConvertLeadForm"
import { RecoverLeadApplicationForm } from "@/components/crm/RecoverLeadApplicationForm"
import { getStaffTenantId } from "@/lib/session-tenant"
import { resetStrandedConvertedLead } from "@/app/actions/crm"
import { leadConversionState } from "@/lib/crm/lead-conversion"
import { Prisma } from "@prisma/client"
import { CONSUMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"

async function getLead(id: string, tenantId: string) {
  return prisma.lead.findFirst({
    where: { id, tenantId },
    include: {
      convertedToClient: {
        select: {
          id: true,
          idNumber: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          employmentStatus: true,
          employerName: true,
          monthlyIncome: true,
          monthlyExpenses: true,
        },
      },
    },
  })
}

async function getRecoveryCandidates(leadId: string, clientId: string, tenantId: string) {
  return prisma.$queryRaw<Array<{
    id: string
    reference: string
    status: string
    submittedAt: Date | null
  }>>(Prisma.sql`
    SELECT DISTINCT
      application."id",
      application."reference",
      application."status"::text AS "status",
      application."submittedAt"
    FROM "LoanApplication" AS application
    INNER JOIN "AuditLog" AS audit
      ON audit."tenantId" = application."tenantId"
     AND audit."entityId" = application."id"
     AND audit."entity" = 'LoanApplication'
     AND audit."action" IN ('APPLICATION_SUBMITTED_BY_CLIENT', 'APPLICATION_SUBMITTED_BY_STAFF')
    WHERE application."tenantId" = ${tenantId}
      AND application."clientId" = ${clientId}
      AND audit."newValue" ->> 'leadId' = ${leadId}
      AND audit."newValue" ->> 'clientId' = ${clientId}
      AND NOT EXISTS (
        SELECT 1
        FROM "Lead" AS other_lead
        WHERE other_lead."tenantId" = ${tenantId}
          AND other_lead."id" <> ${leadId}
          AND other_lead."convertedToApplicationId" = application."id"
      )
    ORDER BY application."reference"
  `)
}

async function getProducts(tenantId: string) {
  return prisma.loanProduct.findMany({
    where: { tenantId, active: true, ...CONSUMER_PRODUCT_WHERE },
    select: { id: true, name: true, productType: true, minAmount: true, maxAmount: true, minTermDays: true, maxTermDays: true },
    orderBy: { name: "asc" },
  })
}

export default async function ConvertLeadPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const tenantId = await getStaffTenantId()
  const [lead, products] = await Promise.all([getLead(id, tenantId), getProducts(tenantId)])

  if (!lead) notFound()

  const conversionState = leadConversionState(
    lead.status,
    lead.convertedToClientId,
    lead.convertedToApplicationId,
    lead.conversionRecoveryRequired,
  )
  const resumableRecovery = conversionState === "INCOMPLETE" && lead.convertedToClient !== null
  const recoveryCandidates = resumableRecovery
    ? await getRecoveryCandidates(id, lead.convertedToClient!.id, tenantId)
    : []

  if (resumableRecovery && recoveryCandidates.length > 0) {
    return (
      <div className="p-6 lg:p-8">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "CRM", href: "/crm" },
            { label: "Leads", href: "/crm/leads" },
            { label: `${lead.firstName} ${lead.lastName}`, href: `/crm/leads/${id}` },
            { label: "Recover conversion" },
          ]}
        />
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
            <h1 className="text-lg font-bold text-amber-950">Select conversion evidence</h1>
            <p className="mt-1 text-sm text-amber-800">
              More than one historical application may match this linked client. Select the exact
              audited application; the choice and reason are locked and recorded atomically.
            </p>
          </div>
          <RecoverLeadApplicationForm
            leadId={id}
            candidates={recoveryCandidates.map((candidate) => ({
              ...candidate,
              submittedAt: candidate.submittedAt?.toISOString() ?? null,
            }))}
          />
        </div>
      </div>
    )
  }

  if (conversionState !== "OPEN" && !resumableRecovery) {
    const stranded = conversionState === "STRANDED"
    const incomplete = conversionState === "INCOMPLETE"
    const needsRepair = stranded || incomplete
    return (
      <div className="p-6 lg:p-8">
        <Breadcrumbs
          className="mb-6"
          items={[
            { label: "CRM", href: "/crm" },
            { label: "Leads", href: "/crm/leads" },
            { label: `${lead.firstName} ${lead.lastName}`, href: `/crm/leads/${id}` },
            { label: "Convert" },
          ]}
        />
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center max-w-md mx-auto">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${needsRepair ? "bg-amber-100" : "bg-green-100"}`}>
            {needsRepair ? (
              <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m0 3.75h.008M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4.5c-.77-1.33-2.7-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
              </svg>
            ) : (
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">
            {conversionState === "COMPLETE" ? "Already Converted" : "Conversion Incomplete"}
          </h2>
          <p className="text-sm text-gray-500">
            {stranded
              ? "This lead is marked Converted but no client record was created — the status was changed directly instead of going through the convert flow. Reset it to retry."
              : incomplete
                ? "This legacy conversion is missing an exact client or application link. It cannot be replayed or converted again until the evidence is repaired."
                : "This lead has already been converted to a client and application."}
          </p>
          {stranded ? (
            <form action={resetStrandedConvertedLead.bind(null, id)} className="mt-4">
              <button
                type="submit"
                className="inline-block px-4 py-2 rounded-md text-white text-sm font-medium bg-amber-600 hover:bg-amber-700"
              >
                Reset to Qualified &amp; Retry Conversion
              </button>
            </form>
          ) : (
            <div className="mt-4 flex justify-center gap-3">
              {lead.convertedToClientId && (
              <Link
                href={`/clients/${lead.convertedToClientId}`}
                className="inline-block px-4 py-2 rounded-md text-white text-sm font-medium"
                style={{ backgroundColor: "#16A085" }}
              >
                View Client →
              </Link>
              )}
              {conversionState === "COMPLETE" && lead.convertedToApplicationId && (
                <Link
                  href={`/applications/${lead.convertedToApplicationId}`}
                  className="inline-block px-4 py-2 rounded-md border border-gray-200 text-sm font-medium text-gray-700"
                >
                  View Application →
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Parse lead notes for pre-fill (website leads store data in notes field).
  // Recovery uses the immutable linked Client identity/financial profile and
  // only asks staff for the missing application inputs.
  const prefill = parseLeadNotes(lead.notes ?? "")
  if (resumableRecovery && lead.convertedToClient) {
    prefill["ID Number"] = lead.convertedToClient.idNumber
    prefill["Employment"] = lead.convertedToClient.employmentStatus ?? "EMPLOYED"
    prefill["Employer"] = lead.convertedToClient.employerName ?? ""
    prefill["Monthly Income"] = String(lead.convertedToClient.monthlyIncome / 100)
    prefill["Monthly Expenses"] = String(lead.convertedToClient.monthlyExpenses / 100)
  }

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-6"
        items={[
          { label: "CRM", href: "/crm" },
          { label: "Leads", href: "/crm/leads" },
          { label: `${lead.firstName} ${lead.lastName}`, href: `/crm/leads/${id}` },
          { label: "Convert" },
        ]}
      />

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {resumableRecovery ? "Resume Incomplete Conversion" : "Convert Lead to Client"}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {resumableRecovery
            ? "The Client already exists. Its stored identity and affordability profile are locked; complete the missing application with an audited recovery reason."
            : <>Review and complete the client profile for <strong>{lead.firstName} {lead.lastName}</strong>, then submit their loan application.</>}
        </p>
      </div>

      <ConvertLeadForm
        lead={{
          id: lead.id,
          firstName: lead.convertedToClient?.firstName ?? lead.firstName,
          lastName: lead.convertedToClient?.lastName ?? lead.lastName,
          email: lead.convertedToClient?.email ?? lead.email ?? "",
          phone: lead.convertedToClient?.phone ?? lead.phone,
        }}
        prefill={prefill}
        products={products}
        recoveryMode={resumableRecovery}
      />
    </div>
  )
}

/** Parse the notes field written by the website application endpoint */
function parseLeadNotes(notes: string): Record<string, string> {
  const result: Record<string, string> = {}
  // Format: "KEY: VALUE | KEY: VALUE | ..."
  const parts = notes.split("|")
  for (const part of parts) {
    const colonIdx = part.indexOf(":")
    if (colonIdx === -1) continue
    const key = part.slice(0, colonIdx).trim()
    const value = part.slice(colonIdx + 1).trim()
    result[key] = value
  }
  return result
}
