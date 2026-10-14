"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { SectionHeader } from "@/components/app-shell/SectionHeader"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Upload, Eye, Trash2, CheckCircle, AlertCircle, Clock, RefreshCcw, Loader2, Camera, Fingerprint } from "lucide-react"
import { toast } from "@/lib/toast"
import { UploadDialog } from "@/components/documents/UploadDialog"
import { DocumentPreviewDialog } from "@/components/documents/DocumentPreviewDialog"
import {
  REQUIRED_DOC_TYPES,
  formatFileSize,
  type DocumentRecord,
} from "@/lib/document-types"
import type {
  PortalKycChecklist,
  PortalKycItemStatus,
} from "@/lib/kyc/portal-checklist"
import {
  deletePortalDocumentAndReconcile,
  PortalDocumentPoller,
} from "@/lib/kyc/portal-document-poller"
import { portalSelfieFailureKind } from "@/lib/kyc/biometric-failure-copy"
import { useLocale, useT } from "@/lib/i18n/client"
import { formatDay } from "@/lib/i18n/format"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { docTypeLabel } from "@/lib/i18n/portal-labels"

interface Props {
  clientId: string
  popiaConsentGiven: boolean
  initialDocs: DocumentRecord[]
  initialKycChecklist: PortalKycChecklist
}

interface DocumentsWithKycResponse {
  documents: DocumentRecord[]
  kycChecklist: PortalKycChecklist
}

const PORTAL_UPLOAD_TYPES = [
  ...REQUIRED_DOC_TYPES,
  "SELFIE",
  "OTHER",
]

// English keeps its existing date (en-ZA, numeric); another language uses the
// shared locale formatter.
function uploadedOn(iso: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return new Date(iso).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })
  return formatDay(iso, locale)
}

export function PortalDocumentsClient({
  clientId,
  popiaConsentGiven: _popiaConsentGiven,
  initialDocs,
  initialKycChecklist,
}: Props) {
  const [docs, setDocs] = useState<DocumentRecord[]>(initialDocs)
  const [kycChecklist, setKycChecklist] =
    useState<PortalKycChecklist>(initialKycChecklist)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [selectedUploadType, setSelectedUploadType] = useState<string | undefined>()
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const mounted = useRef(true)
  const poller = useRef<PortalDocumentPoller | null>(null)
  const t = useT("portalDocuments")
  const labels = useT("portalLabels")
  const locale = useLocale()
  const docLabel = (docType: string) => docTypeLabel(labels, docType)
  const selfieFailure = (reason: string | null | undefined) =>
    t(`selfieFail_${portalSelfieFailureKind(reason)}`)

  const refreshDocumentState = useCallback(async () => {
    const res = await fetch(
      `/api/clients/${clientId}/documents?includeKycChecklist=1`,
    )
    if (!res.ok) return null
    const state = (await res.json()) as DocumentsWithKycResponse
    if (mounted.current) {
      setDocs(state.documents)
      setKycChecklist(state.kycChecklist)
    }
    return state
  }, [clientId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const nextPoller = new PortalDocumentPoller(refreshDocumentState)
    poller.current = nextPoller
    return () => {
      nextPoller.dispose()
      if (poller.current === nextPoller) poller.current = null
    }
  }, [refreshDocumentState])

  useEffect(() => {
    poller.current?.sync(docs)
  }, [docs])

  const handleUploadComplete = useCallback(() => {
    poller.current?.reconcile()
  }, [])

  const handleDelete = async (docId: string) => {
    if (!confirm(t("confirmDelete"))) return
    setDeletingId(docId)
    try {
      const result = await deletePortalDocumentAndReconcile({
        documentId: docId,
        request: fetch,
        reconcile: () => poller.current?.reconcile(),
      })
      if (!result.ok) {
        toast.error(
          t("notDeletedTitle"),
          result.error ?? t("notDeletedBody"),
        )
      }
    } catch {
      toast.networkError()
    } finally {
      setDeletingId(null)
    }
  }

  // Statutory artifacts (agreement, quotation, debit mandate) can never be
  // deleted — the server refuses them categorically, so no button is offered.
  const UNDELETABLE_DOC_TYPES = new Set([
    "CREDIT_AGREEMENT",
    "FORM_20_PRE_AGREEMENT",
    "DEBIT_MANDATE",
  ])

  const handleReplace = (docType: string) => {
    setSelectedUploadType(docType)
    setUploadOpen(true)
  }

  const hasIdDocument = docs.some(d => d.docType === "ID_COPY" && !d.deletedAt)
  const selfieDoc = kycChecklist.latestSelfieId
    ? docs.find((document) => document.id === kycChecklist.latestSelfieId)
    : undefined

  const docsByType = new Map<string, DocumentRecord>()
  for (const d of docs) {
    if (!docsByType.has(d.docType) || d.verified) {
      docsByType.set(d.docType, d)
    }
  }

  const customerActionTypes = REQUIRED_DOC_TYPES.filter((docType) => {
    const status = kycChecklist.coreDocuments[docType].status
    return status === "missing" || status === "action_required"
  })
  const selfieVerified = kycChecklist.selfie.status === "verified"
  const selfieExceptionAccepted =
    kycChecklist.selfie.status === "exception_accepted"
  const selfiePending = kycChecklist.selfie.status === "pending_review"
  // Nothing is running while staff review the ID copy: no spinner.
  const selfieAwaitingIdVerification =
    selfiePending && kycChecklist.selfie.awaitingIdVerification
  const selfieFailed = kycChecklist.selfie.status === "action_required"
  const remainingChecklistItems = kycChecklist.customerActionCount

  const coreStatusCopy = (
    status: PortalKycItemStatus,
    documentPresent: boolean,
  ) => {
    if (status === "verified") {
      return {
        detail: t("coreVerifiedDetail"),
        label: t("verified"),
        tone: "success" as const,
      }
    }
    if (status === "pending_review") {
      return {
        detail: t("corePendingDetail"),
        label: t("pendingReview"),
        tone: "warning" as const,
      }
    }
    if (status === "action_required") {
      return {
        detail: t("coreActionDetail"),
        label: t("actionNeeded"),
        tone: "danger" as const,
      }
    }
    return {
      detail: documentPresent
        ? t("coreActionDetail")
        : t("coreUploadNow"),
      label: t("missing"),
      tone: "danger" as const,
    }
  }

  const documentStatus = (doc: DocumentRecord) => {
    if (doc.docType !== "SELFIE") {
      const checklistItem = doc.docType in kycChecklist.coreDocuments
        ? kycChecklist.coreDocuments[
            doc.docType as keyof typeof kycChecklist.coreDocuments
          ]
        : undefined
      if (checklistItem?.documentId === doc.id) {
        if (checklistItem.status === "verified") {
          return { label: t("verified"), tone: "success" as const }
        }
        if (checklistItem.status === "pending_review") {
          return { label: t("pendingReview"), tone: "info" as const }
        }
        if (checklistItem.status === "action_required") {
          return { label: t("actionNeeded"), tone: "danger" as const }
        }
      }
      return doc.verified
        ? { label: t("verified"), tone: "success" as const }
        : { label: t("superseded"), tone: "neutral" as const }
    }
    if (doc.id !== kycChecklist.latestSelfieId) {
      return { label: t("superseded"), tone: "neutral" as const }
    }
    if (kycChecklist.selfie.status === "exception_accepted") {
      return { label: t("seniorException"), tone: "warning" as const }
    }
    if (kycChecklist.selfie.status === "verified") {
      return { label: t("verified"), tone: "success" as const }
    }
    if (kycChecklist.selfie.status === "pending_review") {
      return { label: t("pendingReview"), tone: "info" as const }
    }
    if (kycChecklist.selfie.status === "action_required") {
      return { label: t("actionNeeded"), tone: "danger" as const }
    }
    return { label: t("required"), tone: "warning" as const }
  }

  const getExtractionLabel = (
    doc: DocumentRecord,
    isLatestSelfie: boolean,
  ) => {
    if (doc.extractionStatus === "processing" || doc.extractionStatus === "pending") {
      return (
        <span className="flex items-center gap-1 text-xs text-[var(--cf-info)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("analysing")}
        </span>
      )
    }
    if (doc.extractionStatus === "done") {
      return (
        <span className="flex items-center gap-1 text-xs text-[var(--cf-success)]">
          <CheckCircle className="h-3 w-3" />
          {t("scanned")}
        </span>
      )
    }
    if (doc.extractionStatus === "failed" || doc.extractionStatus === "skipped") {
      if (
        isLatestSelfie &&
        (
          kycChecklist.selfie.status === "action_required" ||
          kycChecklist.selfie.status === "exception_accepted"
        )
      ) {
        return null
      }
      return (
        <span className="text-xs text-[var(--cf-text-muted)]">
          {t("couldNotRead")}
        </span>
      )
    }
    return null
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <SectionHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => { setSelectedUploadType(undefined); setUploadOpen(true) }}>
            <Upload className="mr-2 h-4 w-4" />
            {t("upload")}
          </Button>
        }
      />

      <InfoStrip variant="default">
        Your documents are stored securely and used only for credit assessment purposes in accordance with POPIA.
        You may request deletion of unverified documents. Verified documents form part of your credit agreement and cannot be deleted.
      </InfoStrip>

      <DataPanel
        title={t("requiredDocs")}
        description={t("requiredDocsDesc")}
        variant="raised"
        density="loose"
      >
        <div className="mb-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-text-muted)]">
          {kycChecklist.manualReviewHold ? (
            <span>
              {t("manualHold")}
            </span>
          ) : kycChecklist.complete ? (
            <span className="font-medium text-[var(--cf-success)]">
              {kycChecklist.substituteKind === "in_person"
                ? t("completeInPerson")
                : kycChecklist.manualExceptionActive
                  ? t("completeException")
                  : t("completeAll")}
            </span>
          ) : remainingChecklistItems > 0 ? (
            <span>
              {remainingChecklistItems === 1 ? t("actionsNeededOne") : t("actionsNeededMany", { n: remainingChecklistItems })}
            </span>
          ) : kycChecklist.pendingReviewCount > 0 ? (
            <span>
              {kycChecklist.pendingReviewCount === 1 ? t("pendingOne") : t("pendingMany", { n: kycChecklist.pendingReviewCount })}
            </span>
          ) : (
            <span>{t("awaitingFinal")}</span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {REQUIRED_DOC_TYPES.map((dt) => {
            const doc = docsByType.get(dt)
            const status = kycChecklist.coreDocuments[dt].status
            const statusCopy = coreStatusCopy(status, Boolean(doc))
            const label = docLabel(dt)
            return (
              <div
                key={dt}
                className="flex flex-col gap-3 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4 text-sm sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {status === "verified" ? (
                    <CheckCircle className="h-5 w-5 shrink-0 text-[var(--cf-success)]" />
                  ) : status === "pending_review" ? (
                    <Clock className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
                  ) : (
                    <AlertCircle className="h-5 w-5 shrink-0 text-[var(--cf-danger)]" />
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold text-[var(--cf-text)]">{label}</p>
                    <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
                      {statusCopy.detail}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <StatusPill tone={statusCopy.tone}>{statusCopy.label}</StatusPill>
                  <Button variant={status === "verified" || status === "pending_review" ? "outline" : "default"} size="sm" onClick={() => handleReplace(dt)}>
                    {doc ? t("replace") : t("upload")}
                  </Button>
                </div>
              </div>
            )
          })}

          <div className="flex flex-col gap-3 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4 text-sm sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {selfieExceptionAccepted ? (
                <AlertCircle className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
              ) : selfieVerified ? (
                <Fingerprint className="h-5 w-5 shrink-0 text-[var(--cf-success)]" />
              ) : selfieAwaitingIdVerification ? (
                <Clock className="h-5 w-5 shrink-0 text-[var(--cf-info)]" />
              ) : selfiePending ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--cf-info)]" />
              ) : selfieFailed ? (
                <AlertCircle className="h-5 w-5 shrink-0 text-[var(--cf-danger)]" />
              ) : (
                <Camera className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-[var(--cf-text)]">{t("selfieTitle")}</p>
                <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
                  {selfieExceptionAccepted
                    ? t("selfieExceptionDetail")
                    : selfieVerified
                    ? t("selfieVerifiedDetail", { score: String(selfieDoc?.biometricMatchScore) })
                    : selfiePending
                      ? kycChecklist.selfie.awaitingIdVerification
                        ? t("selfieAwaitingId")
                        : kycChecklist.selfie.reason === "document_not_verified"
                        ? t("selfieChecksPassed")
                        : t("selfieReceived")
                      : selfieFailed
                        ? selfieFailure(kycChecklist.selfie.reason)
                        : hasIdDocument
                          ? t("selfieTake")
                          : t("selfieIdFirst")}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              {selfieExceptionAccepted ? (
                <StatusPill tone="warning">{t("seniorException")}</StatusPill>
              ) : selfieVerified ? (
                <StatusPill tone="success">{t("verifiedScore", { score: String(selfieDoc?.biometricMatchScore) })}</StatusPill>
              ) : selfiePending ? (
                <StatusPill tone="info">
                  {kycChecklist.selfie.reason === "document_not_verified" ||
                    kycChecklist.selfie.awaitingIdVerification
                    ? t("pendingReview")
                    : t("verifying")}
                </StatusPill>
              ) : selfieFailed ? (
                <StatusPill tone="danger">{t("actionNeeded")}</StatusPill>
              ) : (
                <StatusPill tone="warning">{t("required")}</StatusPill>
              )}
              <Button variant={selfieVerified || selfieExceptionAccepted ? "outline" : "default"} size="sm" onClick={() => handleReplace("SELFIE")}>
                {selfieVerified || selfieExceptionAccepted || selfieFailed
                  ? t("retake")
                  : selfiePending
                    ? t("replace")
                    : t("takeSelfie")}
              </Button>
            </div>
          </div>
        </div>
      </DataPanel>

      <DataPanel
        title={t("uploadAnother")}
        description={t("uploadAnotherDesc")}
        variant="raised"
        density="loose"
        className="border-[rgba(79,70,229,0.38)] bg-[rgba(79,70,229,0.10)]"
        actions={
          <Button onClick={() => { setSelectedUploadType(undefined); setUploadOpen(true) }}>
            <Upload className="mr-2 h-4 w-4" />
            {t("uploadOther")}
          </Button>
        }
      >
        <div className="space-y-2 text-sm text-[var(--cf-text-muted)]">
          <p>{t("formats")}</p>
          {kycChecklist.manualReviewHold ? (
            <p>{t("holdNote")}</p>
          ) : remainingChecklistItems > 0 ? (
            <p>
              {t("actionNeededList", { list: [
                ...customerActionTypes.map((dt) => docLabel(dt)),
                ...(
                  kycChecklist.selfie.status === "missing" ||
                  kycChecklist.selfie.status === "action_required"
                    ? [t("selfieTitle")]
                    : []
                ),
              ].join(", ") })}
            </p>
          ) : kycChecklist.pendingReviewCount > 0 ? (
            <p>{t("noUploadNeeded")}</p>
          ) : (
            <p className="font-medium text-[var(--cf-success)]">{t("checklistComplete")}</p>
          )}
        </div>
      </DataPanel>

      {docs.length > 0 && (
        <DataPanel title={t("myDocs")} description={t("myDocsDesc")} variant="default" density="compact">
          <div className="divide-y divide-[var(--cf-border-subtle)]">
            {docs.map((doc) => {
              const status = documentStatus(doc)
              const isLatestSelfie =
                doc.docType === "SELFIE" &&
                doc.id === kycChecklist.latestSelfieId
              return (
                <div
                  key={doc.id}
                  data-document-id={doc.id}
                  data-document-status={status.label}
                  className="space-y-2 px-2 py-4 first:pt-1 last:pb-1"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[var(--cf-text)]">
                        {docLabel(doc.docType)}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
                        {uploadedOn(doc.createdAt, locale)} - {formatFileSize(doc.fileSize)}
                      </p>
                    </div>
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewDoc(doc)}
                        aria-label={t("previewAria", { doc: docLabel(doc.docType) })}
                        title={t("preview")}
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                      {!doc.verified && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReplace(doc.docType)}
                            aria-label={t("replaceAria", { doc: docLabel(doc.docType) })}
                            title={t("replace")}
                          >
                            <RefreshCcw className="h-3 w-3" />
                          </Button>
                          {!UNDELETABLE_DOC_TYPES.has(doc.docType) && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-[var(--cf-danger)] hover:bg-[rgba(208,92,75,0.08)]"
                              onClick={() => handleDelete(doc.id)}
                              disabled={deletingId === doc.id}
                              aria-label={t("deleteAria", { doc: docLabel(doc.docType) })}
                              title={t("delete")}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {getExtractionLabel(doc, isLatestSelfie)}

                  {doc.docType === "SELFIE" && !isLatestSelfie && (
                    <div className="flex items-center gap-2 text-xs">
                      <Fingerprint className="h-3 w-3 text-[var(--cf-text-muted)]" />
                      <span className="text-[var(--cf-text-muted)]">{t("supersededSelfie")}</span>
                    </div>
                  )}
                  {isLatestSelfie && selfieVerified && (
                    <div className="flex items-center gap-2 text-xs">
                      <Fingerprint className="h-3 w-3 text-[var(--cf-text-muted)]" />
                      <span className="font-medium text-[var(--cf-success)]">
                        {doc.biometricMatchScore != null
                          ? t("identityVerifiedScore", { score: doc.biometricMatchScore })
                          : t("identityVerified")}
                      </span>
                    </div>
                  )}
                  {isLatestSelfie && selfiePending && (
                    <span className="flex items-center gap-1 text-xs text-[var(--cf-info)]">
                      {selfieAwaitingIdVerification
                        ? <Clock className="h-3 w-3" />
                        : <Loader2 className="h-3 w-3 animate-spin" />}
                      {kycChecklist.selfie.awaitingIdVerification
                        ? t("selfieAwaitingId")
                        : kycChecklist.selfie.reason === "document_not_verified"
                        ? t("checksAwaitingAdvisor")
                        : t("verifyingIdentity")}
                    </span>
                  )}
                  {isLatestSelfie && selfieFailed && (
                    <span className="text-xs text-[var(--cf-danger)]">
                      {selfieFailure(kycChecklist.selfie.reason)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </DataPanel>
      )}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        clientId={clientId}
        onUploadComplete={handleUploadComplete}
        allowedTypes={PORTAL_UPLOAD_TYPES}
        initialDocType={selectedUploadType}
        hasIdDocument={hasIdDocument}
      />

      {previewDoc && (
        <DocumentPreviewDialog
          doc={previewDoc}
          open={!!previewDoc}
          onOpenChange={(open) => { if (!open) setPreviewDoc(null) }}
        />
      )}
    </div>
  )
}
