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
import { SAST_TIME_ZONE } from "@/lib/utils"
import {
  DOC_TYPE_LABELS,
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
import {
  PORTAL_SELFIE_AWAITING_ID_VERIFICATION_MESSAGE,
  portalSelfieFailureMessage,
} from "@/lib/kyc/biometric-failure-copy"

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
    if (!confirm("Delete this document?")) return
    setDeletingId(docId)
    try {
      const result = await deletePortalDocumentAndReconcile({
        documentId: docId,
        request: fetch,
        reconcile: () => poller.current?.reconcile(),
      })
      if (!result.ok) {
        toast.error(
          "Document not deleted",
          result.error ?? "This document cannot be deleted.",
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
  const selfieFailed = kycChecklist.selfie.status === "action_required"
  const remainingChecklistItems = kycChecklist.customerActionCount

  const coreStatusCopy = (
    status: PortalKycItemStatus,
    documentPresent: boolean,
  ) => {
    if (status === "verified") {
      return {
        detail: "Accepted by our team.",
        label: "Verified",
        tone: "success" as const,
      }
    }
    if (status === "pending_review") {
      return {
        detail: "Uploaded. No action is needed while our team reviews it.",
        label: "Pending review",
        tone: "warning" as const,
      }
    }
    if (status === "action_required") {
      return {
        detail: "This document needs attention. Please replace it.",
        label: "Action needed",
        tone: "danger" as const,
      }
    }
    return {
      detail: documentPresent
        ? "This document needs attention. Please replace it."
        : "Upload this document now.",
      label: "Missing",
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
          return { label: "Verified", tone: "success" as const }
        }
        if (checklistItem.status === "pending_review") {
          return { label: "Pending review", tone: "info" as const }
        }
        if (checklistItem.status === "action_required") {
          return { label: "Action needed", tone: "danger" as const }
        }
      }
      return doc.verified
        ? { label: "Verified", tone: "success" as const }
        : { label: "Superseded", tone: "neutral" as const }
    }
    if (doc.id !== kycChecklist.latestSelfieId) {
      return { label: "Superseded", tone: "neutral" as const }
    }
    if (kycChecklist.selfie.status === "exception_accepted") {
      return { label: "Senior exception", tone: "warning" as const }
    }
    if (kycChecklist.selfie.status === "verified") {
      return { label: "Verified", tone: "success" as const }
    }
    if (kycChecklist.selfie.status === "pending_review") {
      return { label: "Pending review", tone: "info" as const }
    }
    if (kycChecklist.selfie.status === "action_required") {
      return { label: "Action needed", tone: "danger" as const }
    }
    return { label: "Required", tone: "warning" as const }
  }

  const getExtractionLabel = (
    doc: DocumentRecord,
    isLatestSelfie: boolean,
  ) => {
    if (doc.extractionStatus === "processing" || doc.extractionStatus === "pending") {
      return (
        <span className="flex items-center gap-1 text-xs text-[var(--cf-info)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          Analysing your document...
        </span>
      )
    }
    if (doc.extractionStatus === "done") {
      return (
        <span className="flex items-center gap-1 text-xs text-[var(--cf-success)]">
          <CheckCircle className="h-3 w-3" />
          Document scanned
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
          We couldn&apos;t read this document automatically. Our team will review it manually.
        </span>
      )
    }
    return null
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <SectionHeader
        eyebrow="Secure document vault"
        title="Documents"
        description="Upload and manage the documents needed for verification and credit assessment."
        actions={
          <Button onClick={() => { setSelectedUploadType(undefined); setUploadOpen(true) }}>
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        }
      />

      <InfoStrip variant="default">
        Your documents are stored securely and used only for credit assessment purposes in accordance with POPIA.
        You may request deletion of unverified documents. Verified documents form part of your credit agreement and cannot be deleted.
      </InfoStrip>

      <DataPanel
        title="Required documents"
        description="Complete each item from this checklist. Use the action on the row instead of searching for the generic upload button."
        variant="raised"
        density="loose"
      >
        <div className="mb-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-text-muted)]">
          {kycChecklist.manualReviewHold ? (
            <span>
              An advisor review is required before the overall KYC outcome can complete. Existing document statuses remain visible below.
            </span>
          ) : kycChecklist.complete ? (
            <span className="font-medium text-[var(--cf-success)]">
              {kycChecklist.substituteKind === "in_person"
                ? "All required documents are complete. Your identity was confirmed in person by our staff, so no selfie is needed."
                : kycChecklist.manualExceptionActive
                  ? "All required documents are complete. A senior manual KYC exception is active; biometric verification did not pass."
                  : "All required documents and selfie verification are complete."}
            </span>
          ) : remainingChecklistItems > 0 ? (
            <span>
              {remainingChecklistItems} action{remainingChecklistItems === 1 ? "" : "s"} needed from you before verification can continue.
            </span>
          ) : kycChecklist.pendingReviewCount > 0 ? (
            <span>
              All required items are uploaded. {kycChecklist.pendingReviewCount} item{kycChecklist.pendingReviewCount === 1 ? " is" : "s are"} awaiting verification; no upload action is needed.
            </span>
          ) : (
            <span>All required evidence is on file and awaiting the final advisor decision.</span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {REQUIRED_DOC_TYPES.map((dt) => {
            const doc = docsByType.get(dt)
            const status = kycChecklist.coreDocuments[dt].status
            const statusCopy = coreStatusCopy(status, Boolean(doc))
            const label = DOC_TYPE_LABELS[dt]
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
                    {doc ? "Replace" : "Upload"}
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
              ) : selfiePending ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--cf-info)]" />
              ) : selfieFailed ? (
                <AlertCircle className="h-5 w-5 shrink-0 text-[var(--cf-danger)]" />
              ) : (
                <Camera className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-[var(--cf-text)]">Selfie verification</p>
                <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
                  {selfieExceptionAccepted
                    ? "A senior reviewer accepted a manual KYC exception for this failed biometric attempt. This is not a biometric pass."
                    : selfieVerified
                    ? `Identity verified at ${selfieDoc?.biometricMatchScore}% match.`
                    : selfiePending
                      ? kycChecklist.selfie.awaitingIdVerification
                        ? PORTAL_SELFIE_AWAITING_ID_VERIFICATION_MESSAGE
                        : kycChecklist.selfie.reason === "document_not_verified"
                        ? "Identity checks passed and are awaiting advisor review."
                        : "Selfie received. Verification is running."
                      : selfieFailed
                        ? portalSelfieFailureMessage(kycChecklist.selfie.reason)
                        : hasIdDocument
                          ? "Take a live selfie so we can match it to your ID."
                          : "Upload your ID first, then take a selfie."}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              {selfieExceptionAccepted ? (
                <StatusPill tone="warning">Senior exception</StatusPill>
              ) : selfieVerified ? (
                <StatusPill tone="success">Verified - {selfieDoc?.biometricMatchScore}%</StatusPill>
              ) : selfiePending ? (
                <StatusPill tone="info">
                  {kycChecklist.selfie.reason === "document_not_verified" ||
                    kycChecklist.selfie.awaitingIdVerification
                    ? "Pending review"
                    : "Verifying"}
                </StatusPill>
              ) : selfieFailed ? (
                <StatusPill tone="danger">Action needed</StatusPill>
              ) : (
                <StatusPill tone="warning">Required</StatusPill>
              )}
              <Button variant={selfieVerified || selfieExceptionAccepted ? "outline" : "default"} size="sm" onClick={() => handleReplace("SELFIE")}>
                {selfieVerified || selfieExceptionAccepted || selfieFailed
                  ? "Retake"
                  : selfiePending
                    ? "Replace"
                    : "Take selfie"}
              </Button>
            </div>
          </div>
        </div>
      </DataPanel>

      <DataPanel
        title="Upload another document"
        description="Use this for supporting files or when an advisor asks for something extra. Checklist items above are faster."
        variant="raised"
        density="loose"
        className="border-[rgba(79,70,229,0.38)] bg-[rgba(79,70,229,0.10)]"
        actions={
          <Button onClick={() => { setSelectedUploadType(undefined); setUploadOpen(true) }}>
            <Upload className="mr-2 h-4 w-4" />
            Upload other file
          </Button>
        }
      >
        <div className="space-y-2 text-sm text-[var(--cf-text-muted)]">
          <p>Accepted formats: JPG, PNG, WebP or PDF. Maximum file size is 10MB.</p>
          {kycChecklist.manualReviewHold ? (
            <p>An advisor must resolve the current verification hold before the checklist can complete.</p>
          ) : remainingChecklistItems > 0 ? (
            <p>
              Action needed: {[
                ...customerActionTypes.map((dt) => DOC_TYPE_LABELS[dt]),
                ...(
                  kycChecklist.selfie.status === "missing" ||
                  kycChecklist.selfie.status === "action_required"
                    ? ["Selfie verification"]
                    : []
                ),
              ].join(", ")}.
            </p>
          ) : kycChecklist.pendingReviewCount > 0 ? (
            <p>No additional upload is currently needed. Submitted items are awaiting verification.</p>
          ) : (
            <p className="font-medium text-[var(--cf-success)]">Checklist complete. Upload here only if we request extra supporting documents.</p>
          )}
        </div>
      </DataPanel>

      {docs.length > 0 && (
        <DataPanel title="My documents" description="Preview, replace or delete documents that are not yet verified." variant="default" density="compact">
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
                        {DOC_TYPE_LABELS[doc.docType] || doc.docType}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
                        {new Date(doc.createdAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })} - {formatFileSize(doc.fileSize)}
                      </p>
                    </div>
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewDoc(doc)}
                        aria-label={`Preview ${DOC_TYPE_LABELS[doc.docType] || doc.docType}`}
                        title="Preview"
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                      {!doc.verified && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReplace(doc.docType)}
                            aria-label={`Replace ${DOC_TYPE_LABELS[doc.docType] || doc.docType}`}
                            title="Replace"
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
                              aria-label={`Delete ${DOC_TYPE_LABELS[doc.docType] || doc.docType}`}
                              title="Delete"
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
                      <span className="text-[var(--cf-text-muted)]">Superseded by a newer selfie attempt.</span>
                    </div>
                  )}
                  {isLatestSelfie && selfieVerified && (
                    <div className="flex items-center gap-2 text-xs">
                      <Fingerprint className="h-3 w-3 text-[var(--cf-text-muted)]" />
                      <span className="font-medium text-[var(--cf-success)]">
                        Identity verified
                        {doc.biometricMatchScore != null
                          ? ` - ${doc.biometricMatchScore}% match`
                          : ""}
                      </span>
                    </div>
                  )}
                  {isLatestSelfie && selfiePending && (
                    <span className="flex items-center gap-1 text-xs text-[var(--cf-info)]">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {kycChecklist.selfie.awaitingIdVerification
                        ? PORTAL_SELFIE_AWAITING_ID_VERIFICATION_MESSAGE
                        : kycChecklist.selfie.reason === "document_not_verified"
                        ? "Identity checks are awaiting advisor review."
                        : "Verifying your identity... This may take up to 60 seconds."}
                    </span>
                  )}
                  {isLatestSelfie && selfieFailed && (
                    <span className="text-xs text-[var(--cf-danger)]">
                      {portalSelfieFailureMessage(kycChecklist.selfie.reason)}
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
