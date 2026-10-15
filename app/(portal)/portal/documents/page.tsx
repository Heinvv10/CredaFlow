import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { PortalDocumentsClient } from "./PortalDocumentsClient"
import { getPortalTenantId } from "@/lib/session-tenant"
import type { DocumentRecord } from "@/lib/document-types"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { FileText } from "lucide-react"
import {
  PORTAL_KYC_SNAPSHOT_OPTIONS,
  readPortalKycDocumentState,
} from "@/lib/kyc/portal-document-state"
import { getT } from "@/lib/i18n/server"

async function getClientData(email: string) {
  const tenantId = await getPortalTenantId()
  return prisma.$transaction(
    (tx) => readPortalKycDocumentState(tx, {
      tenantId,
      clientWhere: { email },
    }),
    PORTAL_KYC_SNAPSHOT_OPTIONS,
  )
}

export default async function PortalDocumentsPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const client = await getClientData(session.user.email)

  if (!client) {
    const t = await getT("portalDocuments")
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <EmptyState
          icon={FileText}
          title={t("noClientTitle")}
          description={t("noClientDesc")}
          action={{ label: t("backToOverview"), href: "/portal" }}
        />
      </div>
    )
  }

  // Strip storagePath before passing to client component
  const docs = client.documents.map((d) => {
    const { storagePath: _sp, ...rest } = d
    return {
      ...rest,
      createdAt: rest.createdAt.toISOString(),
      deletedAt: rest.deletedAt?.toISOString() ?? null,
      verifiedAt: rest.verifiedAt?.toISOString() ?? null,
      extractionResult: rest.extractionResult as Record<string, unknown> | null,
      validationResult: rest.validationResult as DocumentRecord["validationResult"],
      validationMismatch: rest.validationMismatch,
      validationScore: rest.validationScore,
      biometricMatchScore: rest.biometricMatchScore ?? null,
      biometricLiveness: rest.biometricLiveness ?? null,
      biometricVerifiedAt: rest.biometricVerifiedAt?.toISOString() ?? null,
      biometricResult: rest.biometricResult as Record<string, unknown> | null,
    }
  })

  return (
    <PortalDocumentsClient
      clientId={client.id}
      popiaConsentGiven={client.popiaConsentGiven}
      initialDocs={docs}
      initialKycChecklist={client.kycChecklist}
    />
  )
}
