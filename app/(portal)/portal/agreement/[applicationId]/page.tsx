import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { PortalAgreementClient } from "./PortalAgreementClient"
import { getDefaultTenantId } from "@/lib/tenant"

interface Props { params: Promise<{ applicationId: string }> }

export default async function PortalAgreementPage({ params }: Props) {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const { applicationId } = await params
  const tenantId = await getDefaultTenantId()

  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: {
      id: true,
      reference: true,
      agreementGeneratedAt: true,
      agreementSignedAt: true,
      agreementDocumentSha256: true,
      agreementExecutedDocumentId: true,
      pasqDocumentSha256: true,
      repaymentMethod: true,
      client: { select: { email: true, firstName: true, lastName: true } },
    },
  })

  if (!application || application.client.email !== session.user.email) {
    redirect("/portal")
  }

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
