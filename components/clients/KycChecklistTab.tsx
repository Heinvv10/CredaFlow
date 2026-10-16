"use client"

import { useState, useEffect, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  Upload,
  Eye,
  ShieldCheck,
  ShieldX,
  Loader2,
  FileText,
  Sparkles,
  AlertTriangle,
} from "lucide-react"
import { toast } from "@/lib/toast"
import { newestVerifiedIdCopyId } from "@/lib/kyc/verification-restorable"
import { RestorableVerificationHint } from "@/components/clients/RestorableVerificationHint"
import { documentActionFailureMessage } from "@/lib/documents/verify-failure"
import {
  UploadDialog,
  type SelfieAlternatives,
  type SignedAgreementReturn,
} from "@/components/documents/UploadDialog"
import { DocumentPreviewDialog } from "@/components/documents/DocumentPreviewDialog"
import {
  DOC_TYPE_LABELS,
  REQUIRED_DOC_TYPES,
  formatFileSize,
  type DocumentRecord,
} from "@/lib/document-types"
import { formatDate } from "@/lib/utils"

// ── Extraction display ────────────────────────────────────────────────────────

type ExtractionField = { value: unknown }
type DisplayItem = { label: string; value: string }

const EXTRACTION_DISPLAY: Record<string, { key: string; label: string; format?: (v: unknown) => string }[]> = {
  ID_COPY: [
    { key: "documentNumber", label: "ID No" },
    { key: "firstName", label: "First Name" },
    { key: "surname", label: "Surname" },
    { key: "dateOfBirth", label: "DOB" },
  ],
  PAYSLIP: [
    { key: "employerName", label: "Employer" },
    { key: "grossIncome", label: "Gross Income", format: (v) => `R${(Number(v) / 100).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}` },
  ],
  BANK_STATEMENT: [
    { key: "bankName", label: "Bank" },
    { key: "accountNumber", label: "Account" },
    { key: "branchCode", label: "Branch Code" },
  ],
  PROOF_OF_ADDRESS: [
    { key: "addressLine1", label: "Address" },
    { key: "suburb", label: "Suburb" },
    { key: "city", label: "City" },
  ],
}

function getExtractedItems(doc: DocumentRecord): DisplayItem[] {
  if (!doc.extractionResult || doc.extractionStatus !== "done") return []
  const result = doc.extractionResult as Record<string, ExtractionField>
  const mapping = EXTRACTION_DISPLAY[doc.docType] ?? []
  return mapping
    .flatMap(({ key, label, format }) => {
      const field = result[key]
      if (!field || field.value === null || field.value === undefined || field.value === "") return []
      return [{ label, value: format ? format(field.value) : String(field.value) }]
    })
}

// ── Types ─────────────────────────────────────────────────────────────────────

type DocStatus = "missing" | "uploaded" | "verified" | "flagged" | "rejected"

interface RejectDialogState {
  docId: string
  docLabel: string
}

/**
 * What the apply-extraction route reports it would make unusable when the
 * extracted identity differs from what is on file. The route refuses first
 * (409) and only proceeds once the operator has seen this and confirmed —
 * so this dialog is not decoration, it is the second half of that contract.
 */
interface IdentityRevocationState {
  docId: string
  message: string
  changedFields: string[]
  verifiedSelfies: number
  bureauChecks: number
  avsChecks: number
  revokesVerifiedKyc: boolean
}

/**
 * A field the apply-extraction route read off the document and deliberately did
 * not write, because the client record already answers it and a staff member
 * put that answer there. Reported so the card can state what the record kept —
 * without it, "Extraction applied" would imply the extracted account type
 * landed when it did not.
 */
interface SkippedField {
  field: "accountType"
  record: string
  extracted: string
  reason: "record_set_by_staff"
}

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  CHEQUE: "Cheque",
  SAVINGS: "Savings",
  OTHER: "Other",
}

function keptFieldNote(skipped: SkippedField): string {
  const label = (value: string) => ACCOUNT_TYPE_LABEL[value] ?? value
  return `Account type kept as ${label(skipped.record)} — the statement read ${label(skipped.extracted)}.`
}

interface Props {
  clientId: string
  kycStatus: string
  manualExceptionActive?: boolean
  substituteKind?: "senior_exception" | "in_person" | null
  /** Stored PENDING while the evidence derives VERIFIED (lib/kyc/verification-restorable.ts). */
  verificationRestorable?: boolean
  selfieAlternatives?: SelfieAlternatives
  signedAgreementReturn?: SignedAgreementReturn
  /** View and list only: no upload, verify, reject or apply-extraction controls. */
  readOnly?: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KYC_DOC_TYPES = [...REQUIRED_DOC_TYPES] as const

function docStatus(doc: DocumentRecord | undefined): DocStatus {
  if (!doc) return "missing"
  if (doc.verified) return "verified"
  // Verified (incl. accepted-with-override) docs returned above. A note alone
  // cannot say who wrote it — the system writes one when a bank-detail change
  // re-flags a statement (app/api/clients/[id]/route.ts). Only a recorded
  // author makes it a rejection.
  if (doc.verificationRejectedById) return "rejected"
  if (doc.verificationNote) return "flagged"
  return "uploaded"
}

const STATUS_BADGE: Record<DocStatus, { label: string; className: string }> = {
  missing:  { label: "Missing",  className: "bg-red-100 text-red-800" },
  uploaded: { label: "Pending",  className: "bg-amber-100 text-amber-800" },
  verified: { label: "Verified", className: "bg-green-100 text-green-800" },
  flagged:  { label: "Flagged",  className: "bg-amber-100 text-amber-900" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-800" },
}

const STATUS_ICON: Record<DocStatus, React.ReactNode> = {
  missing:  <AlertCircle className="h-4 w-4 text-red-400" />,
  uploaded: <Clock       className="h-4 w-4 text-amber-500" />,
  verified: <CheckCircle className="h-4 w-4 text-green-600" />,
  flagged:  <AlertCircle className="h-4 w-4 text-amber-500" />,
  rejected: <XCircle     className="h-4 w-4 text-red-500" />,
}

/** The client's documents, or null when the route refuses (the list stays as it was). */
async function loadDocuments(clientId: string): Promise<DocumentRecord[] | null> {
  const res = await fetch(`/api/clients/${clientId}/documents`)
  if (!res.ok) return null
  return (await res.json()) as DocumentRecord[]
}

// ── Component ─────────────────────────────────────────────────────────────────

export function KycChecklistTab({
  clientId,
  kycStatus,
  manualExceptionActive = false,
  substituteKind = null,
  verificationRestorable = false,
  selfieAlternatives,
  signedAgreementReturn,
  readOnly = false,
}: Props) {
  const [docs, setDocs]                       = useState<DocumentRecord[]>([])
  const [loading, setLoading]                 = useState(true)
  const [uploadDocType, setUploadDocType]     = useState<string | null>(null)
  const [previewDoc, setPreviewDoc]           = useState<DocumentRecord | null>(null)
  const [verifyingId, setVerifyingId]         = useState<string | null>(null)
  const [rejectDialog, setRejectDialog]       = useState<RejectDialogState | null>(null)
  const [rejectNote, setRejectNote]           = useState("")
  const [rejectingId, setRejectingId]         = useState<string | null>(null)
  const [applyingDocId, setApplyingDocId]     = useState<string | null>(null)
  const [identityRevocation, setIdentityRevocation] = useState<IdentityRevocationState | null>(null)
  const [appliedDocIds, setAppliedDocIds]     = useState<Set<string>>(new Set())
  // Per document, what the apply read but did not write. Kept alongside the
  // applied banner rather than shown in a toast: the officer needs to see that
  // the extracted account type is NOT what the record now says, and a toast is
  // gone by the time they look at the card.
  const [keptFields, setKeptFields]           = useState<Record<string, string[]>>({})
  // Local mirror of the client's KYC status so the banner reflects rollups
  // (verify/reject) without a full page reload. Seeded from the server prop.
  const [kyc, setKyc]                         = useState(kycStatus)

  // A different client is a different list: show the spinner for it.
  const [prevClientId, setPrevClientId]       = useState(clientId)
  if (clientId !== prevClientId) {
    setPrevClientId(clientId)
    setLoading(true)
  }

  // Refresh after a mutation. Handlers await this so a dialog or button state
  // only settles once the new list is on screen.
  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const loaded = await loadDocuments(clientId)
      if (loaded) setDocs(loaded)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  // First load, and a change of client. `ignore` drops a response that lands
  // after the client changed or the tab unmounted.
  useEffect(() => {
    let ignore = false
    loadDocuments(clientId)
      .then((loaded) => { if (!ignore && loaded) setDocs(loaded) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [clientId])

  // Latest non-deleted doc per docType
  const docsByType = new Map<string, DocumentRecord>()
  for (const d of docs) {
    if (!d.deletedAt && !docsByType.has(d.docType)) {
      docsByType.set(d.docType, d)
    }
  }

  const verifiedCount = KYC_DOC_TYPES.filter(
    (dt) => docsByType.get(dt)?.verified
  ).length
  const totalRequired = KYC_DOC_TYPES.length

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleApplyExtraction(docId: string, acknowledgeIdentityRevocation = false) {
    // `setApplyingDocId` only disables the buttons on the next render, so a
    // double-click fires two applies before the disabled prop lands.
    if (applyingDocId) return
    setApplyingDocId(docId)
    try {
      const res = await fetch(`/api/clients/${clientId}/apply-extraction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: docId,
          ...(acknowledgeIdentityRevocation ? { acknowledgeIdentityRevocation: true } : {}),
        }),
      })
      if (res.ok) {
        const applied = await res.json() as { skipped?: SkippedField[] }
        setIdentityRevocation(null)
        setAppliedDocIds((prev) => new Set([...prev, docId]))
        setKeptFields((prev) => ({
          ...prev,
          [docId]: (applied.skipped ?? []).map(keptFieldNote),
        }))
        toast.success("Profile updated", "Extracted data applied to client profile.")
        // An apply can revoke evidence server-side — a bank-detail change
        // un-verifies the statements it no longer matches. Without a refetch
        // the badges keep reading "Verified" for documents that are not, and a
        // status badge is a factual claim about the file.
        await fetchDocs()
        return
      }
      const body = await res.json() as {
        error?: string
        identityRevocation?: Omit<IdentityRevocationState, "docId" | "message">
      }
      // The route refused because applying would make existing evidence
      // unusable. Show what would be lost and let the operator decide, rather
      // than reporting a dead end for a thing they are allowed to do.
      if (body.identityRevocation) {
        setIdentityRevocation({
          docId,
          message: body.error ?? "",
          ...body.identityRevocation,
        })
        return
      }
      // Any other refusal is not overridable from here. Close the dialog if it
      // is open: a confirm attempt can come back refused for a DIFFERENT reason
      // (someone approved the application in between), and leaving it up would
      // show the first refusal's stale counts beside an unrelated error.
      setIdentityRevocation(null)
      toast.error("Apply failed", body.error ?? "Could not apply extraction.")
    } finally {
      setApplyingDocId(null)
    }
  }

  async function handleVerify(docId: string) {
    setVerifyingId(docId)
    try {
      // Use the client-scoped rollup endpoint: it flips the doc's verified flag
      // AND recomputes client.kycStatus from the core docs. The generic
      // /api/documents/[id] PATCH does neither, which left KYC stuck PENDING.
      const res = await fetch(`/api/clients/${clientId}/documents/${docId}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: true }),
      })
      if (res.ok) {
        const data = (await res.json()) as { kycStatus?: string }
        toast.document.verified()
        setDocs((prev) =>
          prev.map((d) =>
            d.id === docId
              ? { ...d, verified: true, verifiedAt: new Date().toISOString(), verificationNote: null }
              : d
          )
        )
        if (data.kycStatus) setKyc(data.kycStatus)
      } else {
        const body = await res.json().catch(() => null)
        toast.error("Verify failed", documentActionFailureMessage(body, "Could not verify document."))
      }
    } finally {
      setVerifyingId(null)
    }
  }

  async function handleRejectConfirm() {
    if (!rejectDialog) return
    const { docId } = rejectDialog
    setRejectingId(docId)
    try {
      const res = await fetch(`/api/clients/${clientId}/documents/${docId}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verified: false,
          rejectReason: rejectNote.trim() || "Rejected by officer",
        }),
      })
      if (res.ok) {
        const data = (await res.json()) as { kycStatus?: string }
        toast.error("Document rejected", rejectNote.trim() || "Rejected by officer")
        if (data.kycStatus) setKyc(data.kycStatus)
        await fetchDocs()
        setRejectDialog(null)
        setRejectNote("")
      } else {
        const body = await res.json().catch(() => null)
        toast.error("Reject failed", documentActionFailureMessage(body, "Could not reject document."))
      }
    } finally {
      setRejectingId(null)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const kycBadgeClass: Record<string, string> = {
    PENDING:  "bg-amber-100 text-amber-800",
    VERIFIED: "bg-green-100 text-green-800",
    FAILED:   "bg-red-100 text-red-800",
    EXPIRED:  "bg-gray-100 text-gray-800",
  }

  return (
    <div className="space-y-6">

      {/* ── Status banner ─────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-sm font-medium text-gray-700">KYC Status</p>
            <Badge className={manualExceptionActive
              ? "bg-amber-100 text-amber-900"
              : kycBadgeClass[kyc] ?? "bg-gray-100 text-gray-800"}>
              {substituteKind === "in_person"
                ? "VERIFIED IN PERSON"
                : manualExceptionActive
                  ? "MANUAL EXCEPTION"
                  : kyc}
            </Badge>
          </div>
          <div className="ml-6">
            <p className="text-sm font-medium text-gray-700">Documents</p>
            <p className="text-sm text-gray-600">
              {verifiedCount} / {totalRequired} verified
            </p>
          </div>
        </div>
        {verifiedCount === totalRequired && (
          <div className="flex items-center gap-2 text-green-700 text-sm font-medium">
            <CheckCircle className="h-5 w-5" />
            All required docs verified
          </div>
        )}
      </div>

      {/* Derived on the server; the local status hides it once a decision lands. */}
      {verificationRestorable && kyc === "PENDING" && (
        <RestorableVerificationHint
          clientId={clientId}
          idDocumentId={newestVerifiedIdCopyId(docs)}
          onRestored={(status) => {
            setKyc(status)
            void fetchDocs()
          }}
        />
      )}

      {/* ── Checklist grid ────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-700">
            Required KYC Documents
          </h3>
        </div>

        {loading ? (
          <div className="p-8 flex justify-center text-gray-400 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="divide-y">
            {KYC_DOC_TYPES.map((docType) => {
              const doc    = docsByType.get(docType)
              const status = docStatus(doc)
              const badge  = STATUS_BADGE[status]
              const extractedItems = doc ? getExtractedItems(doc) : []
              const alreadyApplied = doc ? appliedDocIds.has(doc.id) : false

              return (
                <div key={docType}>
                <div
                  className="flex items-center gap-4 px-4 py-4 hover:bg-gray-50 transition-colors"
                >
                  {/* Status icon */}
                  <div className="shrink-0">{STATUS_ICON[status]}</div>

                  {/* Doc type + file info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">
                      {DOC_TYPE_LABELS[docType] ?? docType}
                    </p>
                    {doc ? (
                      <p className="text-xs text-gray-500 truncate">
                        {doc.fileName}{" "}
                        {doc.fileSize ? `· ${formatFileSize(doc.fileSize)}` : ""}
                        {" · "}
                        Uploaded {formatDate(new Date(doc.createdAt))}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400">Not yet uploaded</p>
                    )}
                    {(status === "rejected" || status === "flagged") && doc?.verificationNote && (
                      <p className="text-xs text-red-600 mt-0.5">
                        {doc.verificationNote.replace("REJECTED: ", "")}
                      </p>
                    )}
                  </div>

                  {/* Badge */}
                  <Badge className={badge.className}>{badge.label}</Badge>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {!doc ? (
                      !readOnly && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setUploadDocType(docType)}
                        >
                          <Upload className="h-3 w-3 mr-1" />
                          Upload
                        </Button>
                      )
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPreviewDoc(doc)}
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          View
                        </Button>

                        {!readOnly && status !== "verified" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-green-700 border-green-300 hover:bg-green-50"
                            onClick={() => handleVerify(doc.id)}
                            disabled={verifyingId === doc.id}
                          >
                            {verifyingId === doc.id ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <ShieldCheck className="h-3 w-3 mr-1" />
                            )}
                            Verify
                          </Button>
                        )}

                        {!readOnly && status !== "rejected" && status !== "flagged" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 border-red-300 hover:bg-red-50"
                            onClick={() =>
                              setRejectDialog({
                                docId:    doc.id,
                                docLabel: DOC_TYPE_LABELS[docType] ?? docType,
                              })
                            }
                          >
                            <ShieldX className="h-3 w-3 mr-1" />
                            Reject
                          </Button>
                        )}

                        {!readOnly && (status === "rejected" || status === "flagged" || status === "verified") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setUploadDocType(docType)}
                          >
                            <Upload className="h-3 w-3 mr-1" />
                            Re-upload
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* OCR suggestions — shown when extraction is done and not yet applied */}
                {!readOnly && extractedItems.length > 0 && !alreadyApplied && (
                  <div className="flex items-start gap-3 px-4 py-2.5 bg-blue-50 border-t border-blue-100">
                    <Sparkles className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                      {extractedItems.map(({ label, value }) => (
                        <span key={label} className="text-[11px] text-blue-700">
                          <span className="font-semibold">{label}:</span> {value}
                        </span>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 h-6 text-[11px] px-2 border-blue-300 text-blue-700 hover:bg-blue-100"
                      disabled={applyingDocId === doc?.id}
                      onClick={() => doc && handleApplyExtraction(doc.id)}
                    >
                      {applyingDocId === doc?.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Apply to profile"
                      )}
                    </Button>
                  </div>
                )}

                {alreadyApplied && extractedItems.length > 0 && (
                  <div className="flex items-start gap-2 px-4 py-1.5 bg-green-50 border-t border-green-100">
                    <CheckCircle className="h-3 w-3 text-green-600 shrink-0 mt-0.5" />
                    <div className="text-[11px] text-green-700">
                      <div>Extraction applied to profile</div>
                      {(doc ? keptFields[doc.id] ?? [] : []).map((note) => (
                        <div key={note} className="text-amber-700">{note}</div>
                      ))}
                    </div>
                  </div>
                )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Reject dialog ─────────────────────────────────────────── */}
      {rejectDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md space-y-4">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-red-500" />
              <h3 className="font-semibold text-gray-900">
                Reject — {rejectDialog.docLabel}
              </h3>
            </div>
            <p className="text-sm text-gray-600">
              Provide a reason for rejection. The document will be marked
              Rejected against your name, the client&apos;s KYC will read FAILED
              until it is resolved, and the client may be notified.
            </p>
            <textarea
              className="w-full border rounded-md p-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
              rows={3}
              placeholder="e.g. Document is blurry or illegible"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => { setRejectDialog(null); setRejectNote("") }}
                disabled={!!rejectingId}
              >
                Cancel
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={handleRejectConfirm}
                disabled={!!rejectingId}
              >
                {rejectingId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Confirm Reject"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Identity-revocation confirmation ──────────────────────── */}
      {identityRevocation && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              <h3 className="font-semibold text-gray-900">
                This changes the client&apos;s identity
              </h3>
            </div>
            <p className="text-sm text-gray-600">
              Applying this document changes{" "}
              <span className="font-medium text-gray-900">
                {identityRevocation.changedFields.join(", ")}
              </span>
              . Evidence already gathered is tied to the current details and
              stops counting once they change:
            </p>
            <ul className="text-sm text-gray-700 space-y-1 list-disc pl-5">
              {identityRevocation.revokesVerifiedKyc && (
                <li>This client&apos;s KYC verification is revoked</li>
              )}
              {identityRevocation.verifiedSelfies > 0 && (
                <li>
                  {identityRevocation.verifiedSelfies} verified selfie
                  {identityRevocation.verifiedSelfies === 1 ? "" : "s"} must be retaken
                </li>
              )}
              {identityRevocation.bureauChecks > 0 && (
                <li>
                  {identityRevocation.bureauChecks} credit-bureau check
                  {identityRevocation.bureauChecks === 1 ? "" : "s"} must be pulled again,
                  which needs fresh consent from the client
                </li>
              )}
              {identityRevocation.avsChecks > 0 && (
                <li>
                  {identityRevocation.avsChecks} bank-account verification
                  {identityRevocation.avsChecks === 1 ? "" : "s"} must be run again
                </li>
              )}
            </ul>
            <p className="text-sm text-gray-600">
              Check the extracted values against the document before continuing.
              If they are wrong, cancel and correct the record by hand instead.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setIdentityRevocation(null)}
                disabled={!!applyingDocId}
              >
                Cancel
              </Button>
              <Button
                className="bg-orange-600 hover:bg-orange-700 text-white"
                onClick={() => handleApplyExtraction(identityRevocation.docId, true)}
                disabled={!!applyingDocId}
              >
                {applyingDocId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Apply and revoke"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dialogs ───────────────────────────────────────────────── */}
      {!readOnly && uploadDocType && (
        <UploadDialog
          open={!!uploadDocType}
          onOpenChange={(open) => { if (!open) setUploadDocType(null) }}
          clientId={clientId}
          onUploadComplete={() => { setUploadDocType(null); fetchDocs() }}
          hasIdDocument={docs.some(
            (d) => d.docType === "ID_COPY" && d.extractionStatus === "done"
          )}
          selfieAlternatives={selfieAlternatives}
          signedAgreementReturn={signedAgreementReturn}
        />
      )}

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
