import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { notFound, redirect } from "next/navigation"
import { PortalAgreementClient } from "./PortalAgreementClient"
import { getResolvedTenantId } from "@/lib/tenant"

interface Props { params: Promise<{ applicationId: string }> }

export default async function PortalAgreementPage({ params }: Props) {
  const session = await auth()
  if (!session?.user || session.user.role !== "CLIENT") redirect("/portal/login")

  const { applicationId } = await params
  // The request's tenant, which the session must belong to (as
  // withTenantContext requires of the APIs this page calls). The application is
  // matched on the session's client id, never its email: a CLIENT JWT is not
  // revalidated, so its email can be stale, or since reassigned to another client.
  const tenantId = await getResolvedTenantId()
  if (session.user.tenantId !== tenantId) notFound()

  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId, clientId: session.user.id },
    select: {
      id: true,
      reference: true,
      agreementGeneratedAt: true,
      agreementSignedAt: true,
      agreementDocumentSha256: true,
      agreementExecutedDocumentId: true,
      pasqDocumentSha256: true,
      repaymentMethod: true,
      client: { select: { firstName: true, lastName: true } },
    },
  })

  if (!application) notFound()

  if (!application.agreementGeneratedAt) {
    redirect("/portal")
  }

  if (application.agreementSignedAt) {
    redirect(
      application.repaymentMethod === "EFT"
        ? `/portal/applications/${application.id}`
        : `/portal/mandate/${application.id}`,
    )
  }

  return (
    <PortalAgreementClient
      applicationId={application.id}
      reference={application.reference}
      clientName={`${application.client.firstName} ${application.client.lastName}`}
      agreementDocumentSha256={application.agreementDocumentSha256 ?? null}
      agreementExecutedDocumentId={application.agreementExecutedDocumentId ?? null}
      pasqDocumentSha256={application.pasqDocumentSha256 ?? null}
      repaymentMethod={application.repaymentMethod}
    />
  )
}
