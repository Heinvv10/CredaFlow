"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Upload, CheckCircle, AlertCircle, Clock, RotateCcw, Trash2, ShieldCheck, Eye, ChevronDown, ChevronUp, FileText, AlertTriangle, Camera, Fingerprint, Download, PenLine } from "lucide-react"
import { toast } from "@/lib/toast"
import { documentActionFailureMessage } from "@/lib/documents/verify-failure"
import { genericDocumentActionPolicy } from "@/lib/documents/generic-action-policy"
import {
  SIGNING_PACKET_COMPONENT_NOTE,
  partitionSigningPacketDocuments,
} from "@/lib/documents/signing-packet-visibility"
import type { SigningPacketLifecycle } from "@/lib/documents/signing-packet-lifecycle"
import {
  UploadDialog,
  type SelfieAlternatives,
  type SignedAgreementReturn,
} from "./UploadDialog"
import { DocumentPreviewDialog } from "./DocumentPreviewDialog"
import { ValidationBanner } from "./ValidationBanner"
import {
  DOC_TYPE_LABELS,
  REQUIRED_DOC_TYPES,
  SYSTEM_GENERATED_DOC_TYPES,
  formatFileSize,
  type DocumentRecord,
} from "@/lib/document-types"
import { SAST_TIME_ZONE, formatZAR } from "@/lib/utils"

interface Props {
  clientId: string
  popiaConsentGiven: boolean
  selfieAlternatives?: SelfieAlternatives
  signedAgreementReturn?: SignedAgreementReturn
  /** View and list only: no upload, verify, override, extract or delete. */
  readOnly?: boolean
}

/**
 * Extraction fields the VLM returns in CENTS (see VLM_PROMPTS.PAYSLIP). Rendering
 * the raw integer showed a R20,000.00 net pay as "2000000", which staff read as a
 * misextraction. Format these as rands; leave every other field as-is.
 *
 * Deliberately duplicates PAYSLIP_MONEY_FIELDS in lib/vlm-extract.ts rather than
 * importing it: this is a client component, and that module dynamically imports
 * child_process/fs for PDF rasterising. Keep the two lists in step by hand.
 */
const EXTRACTION_CENTS_FIELDS = new Set(["grossIncome", "netIncome", "totalDeductions"])

function formatExtractedValue(key: string, value: unknown): string {
  if (EXTRACTION_CENTS_FIELDS.has(key)) {
    const cents = Number(value)
    if (Number.isFinite(cents)) return formatZAR(cents)
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

export function DocumentsTab({
  clientId,
  popiaConsentGiven,
  selfieAlternatives,
  signedAgreementReturn,
  readOnly = false,
}: Props) {
  const [docs, setDocs] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null)
  const [expandedExtractions, setExpandedExtractions] = useState<Set<string>>(new Set())
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [packetComponentsOpen, setPacketComponentsOpen] = useState(false)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [extractingId, setExtractingId] = useState<string | null>(null)
  const [packets, setPackets] = useState<SigningPacketLifecycle[]>([])
  const router = useRouter()

  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/clients/${clientId}/documents`)
      if (res.ok) {
        const data = await res.json()
        setDocs(data)
      }
    } finally {
      setLoading(false)
    }
  }, [clientId])

  // Kept separate from fetchDocs: the packet card is application-scoped and a
  // failure here must not blank the document list, nor the reverse.
  const fetchPackets = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}/signing-packets`)
      if (!res.ok) return
      const data = await res.json()
      if (!Array.isArray(data)) return
      // Array.isArray alone is not enough. Any JSON array reaches this — a
      // different endpoint's payload, a proxy error body — and every field the
      // card reads would be undefined, so it rendered an empty "Signing packet"
      // shell for a client with no packet, with a duplicate React key. On a
      // lender, a card asserting a packet exists when none does is worse than
      // no card. Only entries carrying the two fields the card cannot render
      // without are accepted.
      setPackets(data.filter((p): p is SigningPacketLifecycle =>
        typeof p?.applicationId === "string" && typeof p?.state === "string"))
    } catch {
      // Leave the previous state: the halves and any executed agreement are
      // still listed below, so staff are not stranded without a download.
    }
  }, [clientId])

  useEffect(() => { fetchDocs() }, [fetchDocs])
  useEffect(() => { fetchPackets() }, [fetchPackets])

  // Auto-poll every 5s while any doc is pending/processing
  useEffect(() => {
    const hasActive = docs.some(
      (d) => genericDocumentActionPolicy(d.docType).showGenericExtraction
        && (d.extractionStatus === "pending" || d.extractionStatus === "processing")
    )
    if (!hasActive) return
    const timer = setInterval(fetchDocs, 5000)
    return () => clearInterval(timer)
  }, [docs, fetchDocs])

  const handleDelete = async (docId: string) => {
    const doc = docs.find((d) => d.id === docId)
    const label = doc ? (DOC_TYPE_LABELS[doc.docType] ?? doc.docType) : "this document"
    const isStatutory = doc
      ? (SYSTEM_GENERATED_DOC_TYPES as readonly string[]).includes(doc.docType)
      : false
    // The old copy said "permanently removed", which was never true — this is a
    // soft delete; the bytes and the access history stay on record. Naming the
    // document and stating what actually happens matters more here than a
    // generic prompt: only a SUPER_ADMIN reaches this, and for a bound
    // agreement or PASQ the database itself will refuse.
    const warning = isStatutory
      ? `\n\nThis is a statutory document generated by the system. If it is still bound to an approved or disbursed application the database will refuse, and a signed credit agreement cannot be regenerated — the only way back is to return the application to review and have the consumer sign again.`
      : ""
    if (!confirm(
      `Delete "${doc?.fileName ?? docId}" (${label})?`
      + `\n\nIt is retired from every list, delivery and signing surface. The file and its access history are retained on record for audit.`
      + warning,
    )) return
    setDeletingId(docId)
    try {
      const res = await fetch(`/api/documents/${docId}`, { method: "DELETE" })
      if (res.ok) {
        setDocs((prev) => prev.filter((d) => d.id !== docId))
        // Refresh the server component so the parent tab badge (Documents (N),
        // rendered server-side from client.documents.length) doesn't go stale
        // after a delete (audit N-11).
        router.refresh()
      } else {
        const body = await res.json().catch(() => null)
        toast.error(
          "Document not deleted",
          documentActionFailureMessage(body, "The server refused the deletion."),
        )
      }
    } catch {
      toast.networkError()
    } finally {
      setDeletingId(null)
    }
  }

  const handleVerify = async (docId: string) => {
    setVerifyingId(docId)
    try {
      // Client-scoped rollup endpoint so verifying a core KYC doc here also
      // recomputes client.kycStatus (the generic /api/documents/[id] PATCH does not).
      const res = await fetch(`/api/clients/${clientId}/documents/${docId}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: true }),
      })
      if (res.ok) {
        toast.document.verified()
        setDocs((prev) =>
          prev.map((d) =>
            d.id === docId ? { ...d, verified: true, verifiedAt: new Date().toISOString() } : d
          )
        )
      } else {
        const body = await res.json().catch(() => null)
        toast.error("Verify failed", documentActionFailureMessage(body, "Could not verify document."))
      }
    } finally {
      setVerifyingId(null)
    }
  }

  const handleOverride = async (docId: string, note: string) => {
    setVerifyingId(docId)
    try {
      const res = await fetch(`/api/clients/${clientId}/documents/${docId}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: true, note: `OVERRIDE: ${note}` }),
      })
      if (res.ok) {
        toast.success("Mismatch overridden", "Document manually accepted by officer.")
        setDocs((prev) =>
          prev.map((d) =>
            d.id === docId ? { ...d, verified: true, verifiedAt: new Date().toISOString(), verificationNote: `OVERRIDE: ${note}` } : d
          )
        )
      } else {
        const body = await res.json().catch(() => null)
        toast.error("Override failed", documentActionFailureMessage(body, "Could not override document."))
      }
    } finally {
      setVerifyingId(null)
    }
  }

  const handleExtract = async (docId: string) => {
    setExtractingId(docId)
    setDocs((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, extractionStatus: "processing" } : d))
    )
    try {
      const res = await fetch(`/api/documents/${docId}/extract`, { method: "POST" })
      const body = await res.json()
      if (body.ok) {
        // Re-fetch to get validation results too
        await fetchDocs()
      } else {
        setDocs((prev) =>
          prev.map((d) =>
            d.id === docId
              ? { ...d, extractionStatus: "failed", extractionError: body.error }
              : d
          )
        )
      }
    } finally {
      setExtractingId(null)
    }
  }

  const toggleExtraction = (docId: string) => {
    setExpandedExtractions((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
  }

  const hasIdDocument = docs.some(d => d.docType === "ID_COPY" && d.extractionStatus === "done")

  const docsByType = new Map<string, DocumentRecord>()
  for (const d of docs) {
    if (!docsByType.has(d.docType)) docsByType.set(d.docType, d)
  }

  // Selfie verification status
  const selfieDoc = docs.find(d => d.docType === "SELFIE" && !d.deletedAt)

  // The PASQ and credit agreement are halves of one signed packet, not two
  // documents to send. They stay in the record and remain reachable — just not
  // as the obvious thing to attach to an email.
  const { primary, packetComponents } = partitionSigningPacketDocuments(docs)

  // ONE card per signing packet, replacing the two unsigned halves as the thing
  // staff act on. Which artifact is authoritative depends on how far the
  // application has travelled, so the state and the download both come from the
  // server (lib/documents/signing-packet-lifecycle.ts) rather than being
  // inferred from document rows here.
  const renderPacketCard = (packet: SigningPacketLifecycle) => {
    // Executed wins over every warning tone, by being FIRST in the chain below.
    // A superseded packet is a fact about the road travelled, not about the
    // executed artifact, and painting a completed agreement red would contradict
    // its own headline.
    //
    // `warn` deliberately does NOT re-test state !== "executed": the ordering
    // already decides that, so the extra condition could never change the
    // outcome. Mutation-testing caught it surviving — a check that cannot fail
    // reads as protection it isn't.
    const warn = packet.supersededReturnedPacket || packet.unrecordedReturnedPacket
    const tone = packet.state === "executed"
      ? { border: "border-green-300", bg: "bg-green-50", badge: "bg-green-100 text-green-800", icon: CheckCircle, iconColor: "text-green-600" }
      : warn
        ? { border: "border-red-300", bg: "bg-red-50", badge: "bg-red-100 text-red-800", icon: AlertTriangle, iconColor: "text-red-600" }
        : packet.state === "signed_awaiting_countersignature"
          ? { border: "border-blue-300", bg: "bg-blue-50", badge: "bg-blue-100 text-blue-800", icon: PenLine, iconColor: "text-blue-600" }
          : packet.state === "not_issued"
            ? { border: "border-gray-200", bg: "bg-gray-50", badge: "bg-gray-100 text-gray-700", icon: FileText, iconColor: "text-gray-400" }
            : { border: "border-amber-300", bg: "bg-amber-50", badge: "bg-amber-100 text-amber-800", icon: Clock, iconColor: "text-amber-600" }
    const StateIcon = tone.icon

    return (
      <div
        key={packet.applicationId}
        className={`rounded-lg border ${tone.border} ${tone.bg} p-4 space-y-3`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <StateIcon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.iconColor}`} />
            <div>
              <p className="text-sm font-medium text-gray-900">Signing packet</p>
              <p className="mt-0.5 text-xs text-gray-600">
                Application {packet.reference}
              </p>
            </div>
          </div>
          <Badge className={tone.badge}>{packet.headline}</Badge>
        </div>

        <p className="text-xs text-gray-700">{packet.detail}</p>

        {packet.downloadUrl && (
          <div className="flex items-center gap-2 border-t pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(packet.downloadUrl!, "_blank")}
            >
              <Eye className="mr-1 h-3 w-3" />
              View
            </Button>
            {/* Only offered for a STORED document. The live packet endpoint
                hardcodes Content-Disposition: inline and takes no download
                flag, so a Download button there opens the same tab as View and
                promises an action it does not perform. */}
            {packet.documentId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`${packet.downloadUrl}?download=1`, "_blank")}
              >
                <Download className="mr-1 h-3 w-3" />
                Download
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  // One card renderer, used for the main grid and for the collapsed packet
  // halves, so the two lists can never drift apart in behaviour.
  const renderDocumentCard = (doc: DocumentRecord) => {
          const actionPolicy = genericDocumentActionPolicy(doc.docType)

          return (
            <div key={doc.id} className="bg-white rounded-lg shadow-sm border p-4 space-y-3">
            {/* Header row */}
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-sm text-gray-900">
                  {DOC_TYPE_LABELS[doc.docType] || doc.docType}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{doc.fileName}</p>
              </div>
              {actionPolicy.lockedStatutoryEvidence ? (
                <Badge className="bg-blue-100 text-blue-800">
                  {actionPolicy.badgeLabel}
                </Badge>
              ) : doc.verified ? (
                <Badge className="bg-green-100 text-green-800">Verified</Badge>
              ) : (
                <Badge className="bg-amber-100 text-amber-800">Unverified</Badge>
              )}
            </div>

            {/* Validation banner */}
            {actionPolicy.showGenericValidation && (
              <ValidationBanner
                validationResult={doc.validationResult}
                validationMismatch={doc.validationMismatch}
                validationScore={doc.validationScore}
                extractionStatus={doc.extractionStatus}
                extractionError={doc.extractionError}
                hasExtractedData={doc.extractionResult != null}
                docType={doc.docType}
                verified={doc.verified}
                docId={doc.id}
                onOverride={readOnly ? undefined : handleOverride}
              />
            )}

            {/* Biometric results for selfie docs */}
            {doc.docType === "SELFIE" && doc.biometricMatchScore != null && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-gray-500" />
                  <span className="text-sm font-medium">Biometric Match: {doc.biometricMatchScore}%</span>
                  {doc.biometricMatchScore >= 70 ? (
                    <Badge className="bg-green-100 text-green-800 text-xs">Identity Verified</Badge>
                  ) : (
                    <Badge className="bg-red-100 text-red-800 text-xs">Match Failed ({doc.biometricMatchScore}%)</Badge>
                  )}
                </div>
                {doc.biometricLiveness != null && (
                  <p className="text-xs text-gray-600 ml-6">Liveness: {doc.biometricLiveness}%</p>
                )}
              </div>
            )}
            {doc.docType === "SELFIE" && (doc.extractionStatus === "processing" || doc.extractionStatus === "pending") && (
              <p className="text-xs text-blue-500 flex items-center gap-1">
                <RotateCcw className="h-3 w-3 animate-spin" /> Verifying identity with Smile Identity...
              </p>
            )}

            {/* Meta row */}
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>{new Date(doc.createdAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })}</span>
              <span>{formatFileSize(doc.fileSize)}</span>
              <span>{doc.uploadedByType === "client" ? "Client portal" : "Staff"}</span>
            </div>

            {/* Preview area */}
            <div className="flex items-center gap-2">
              {doc.mimeType?.startsWith("image/") ? (
                <button
                  onClick={() => setPreviewDoc(doc)}
                  className="w-16 h-16 rounded border overflow-hidden bg-gray-100 hover:ring-2 ring-blue-400 transition-all"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/documents/${doc.id}/view`}
                    alt={doc.fileName}
                    className="w-full h-full object-cover"
                  />
                </button>
              ) : (
                <button
                  onClick={() => setPreviewDoc(doc)}
                  className="flex items-center gap-2 px-3 py-2 border rounded text-xs text-blue-600 hover:bg-blue-50"
                >
                  <FileText className="h-4 w-4" />
                  View PDF
                </button>
              )}
            </div>

            {/* Extraction status + extracted data */}
            {actionPolicy.showGenericExtraction && (
              <>
                {doc.extractionStatus === "done" && doc.extractionResult && (
                  <div>
                    <button
                      onClick={() => toggleExtraction(doc.id)}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      {expandedExtractions.has(doc.id) ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                      Extracted Data
                    </button>
                    {expandedExtractions.has(doc.id) && (
                      <div className="mt-2 bg-gray-50 rounded p-3 text-xs space-y-1">
                        {Object.entries(doc.extractionResult).map(([k, v]) => {
                          const field = v as { value?: unknown; validated?: boolean } | unknown
                          const isStructured = typeof field === "object" && field !== null && "value" in field
                          const value = isStructured ? (field as { value: unknown }).value : v
                          // No confidence is read here on purpose. Extractions
                          // stored before 2026-08 carry a `confidence` of 0.95
                          // on every field — a hardcoded literal, never a model
                          // output — which this rendered as "(95%)". Reading it
                          // back would resurrect the same false claim on those
                          // rows. `validated` below is the real signal.
                          const validated = isStructured ? (field as { validated?: boolean }).validated : undefined
                          // Any underscore-prefixed field the extractor marked
                          // unvalidated is a reviewer-facing warning (ID checks,
                          // payslip totals reconciliation). Notes stay hidden.
                          const isWarning = k.startsWith("_") && validated === false

                          if (k.startsWith("_") && isWarning) {
                            return (
                              <div key={k} className="flex items-start gap-1 p-1.5 bg-orange-50 rounded border border-orange-200">
                                <AlertTriangle className="h-3 w-3 text-orange-600 mt-0.5 shrink-0" />
                                <span className="text-orange-700">{String(value)}</span>
                              </div>
                            )
                          }
                          if (k.startsWith("_")) return null

                          return (
                            <div key={k} className={`flex justify-between ${validated === false ? "text-orange-600" : ""}`}>
                              <span className="text-gray-500 flex items-center gap-1">
                                {validated === false && <AlertTriangle className="h-3 w-3 text-orange-500" />}
                                {k}
                              </span>
                              <span className={`font-medium ${validated === false ? "text-orange-700" : "text-gray-900"}`}>
                                {formatExtractedValue(k, value)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                {doc.extractionStatus === "processing" && (
                  <p className="text-xs text-blue-500 flex items-center gap-1">
                    <RotateCcw className="h-3 w-3 animate-spin" /> Extracting...
                  </p>
                )}
                {doc.extractionStatus === "failed" && (
                  <p className="text-xs text-red-500">
                    Automatic extraction failed. Please review this document manually or retry extraction.
                  </p>
                )}
                {doc.extractionStatus === "skipped" && (
                  <p className="text-xs text-gray-500">
                    {popiaConsentGiven
                      ? "Automatic extraction did not run when this was uploaded. Use Extract to run it now, or review the document manually."
                      : "Automatic extraction did not run — the client has not given POPIA consent. Record consent first, or review the document manually."}
                  </p>
                )}
              </>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreviewDoc(doc)}
              >
                <Eye className="h-3 w-3 mr-1" />
                View
              </Button>
              {!readOnly && actionPolicy.canVerify && !doc.verified && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleVerify(doc.id)}
                  disabled={verifyingId === doc.id}
                >
                  <ShieldCheck className="h-3 w-3 mr-1" />
                  Verify
                </Button>
              )}
              {!readOnly &&
                actionPolicy.canExtract &&
                popiaConsentGiven &&
                (doc.extractionStatus === "failed" ||
                  doc.extractionStatus === "skipped" ||
                  doc.extractionStatus === "pending") && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExtract(doc.id)}
                    disabled={extractingId === doc.id}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Extract
                  </Button>
                )}
              {/* Spacer keeps the remaining actions right-aligned even when
                  Delete is not offered (statutory documents). */}
              <span className="ml-auto" />
              {!readOnly && actionPolicy.canDelete && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700"
                  onClick={() => handleDelete(doc.id)}
                  disabled={deletingId === doc.id}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete
                </Button>
              )}
            </div>
          </div>
          )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Documents</h3>
        {!readOnly && (
          <Button onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Upload Document
          </Button>
        )}
      </div>

      {/* Required docs checklist */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <p className="text-sm font-medium text-gray-700 mb-3">Required Documents</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {REQUIRED_DOC_TYPES.map((dt) => {
            const doc = docsByType.get(dt)
            const verified = doc?.verified
            const hasMismatch = doc?.validationMismatch && !doc?.verified
            return (
              <div
                key={dt}
                className={`flex items-center gap-2 text-sm p-2 rounded ${hasMismatch ? "bg-red-50" : "bg-gray-50"}`}
              >
                {hasMismatch ? (
                  <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
                ) : verified ? (
                  <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                ) : doc ? (
                  <Clock className="h-4 w-4 text-amber-500 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
                )}
                <span className={hasMismatch ? "text-red-800" : verified ? "text-green-800" : doc ? "text-amber-800" : "text-gray-500"}>
                  {DOC_TYPE_LABELS[dt]}
                </span>
              </div>
            )
          })}
          {/* Selfie / biometric verification status */}
          <div
            className={`flex items-center gap-2 text-sm p-2 rounded ${
              selfieDoc?.biometricMatchScore != null && selfieDoc.biometricMatchScore >= 70
                ? "bg-green-50"
                : selfieDoc?.extractionStatus === "processing" || selfieDoc?.extractionStatus === "pending"
                  ? "bg-blue-50"
                  : selfieDoc?.biometricMatchScore != null && selfieDoc.biometricMatchScore < 70
                    ? "bg-red-50"
                    : "bg-gray-50"
            }`}
          >
            {selfieDoc?.biometricMatchScore != null && selfieDoc.biometricMatchScore >= 70 ? (
              <Fingerprint className="h-4 w-4 text-green-600 shrink-0" />
            ) : selfieDoc?.extractionStatus === "processing" || selfieDoc?.extractionStatus === "pending" ? (
              <RotateCcw className="h-4 w-4 text-blue-500 shrink-0 animate-spin" />
            ) : selfieDoc?.biometricMatchScore != null ? (
              <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
            ) : (
              <Camera className="h-4 w-4 text-gray-400 shrink-0" />
            )}
            <span className={
              selfieDoc?.biometricMatchScore != null && selfieDoc.biometricMatchScore >= 70
                ? "text-green-800"
                : selfieDoc?.extractionStatus === "processing" || selfieDoc?.extractionStatus === "pending"
                  ? "text-blue-700"
                  : selfieDoc?.biometricMatchScore != null
                    ? "text-red-800"
                    : "text-gray-500"
            }>
              {selfieDoc?.biometricMatchScore != null && selfieDoc.biometricMatchScore >= 70
                ? `Identity Verified — ${selfieDoc.biometricMatchScore}% match`
                : selfieDoc?.extractionStatus === "processing" || selfieDoc?.extractionStatus === "pending"
                  ? "Verifying identity..."
                  : selfieDoc?.biometricMatchScore != null
                    ? `Verification Failed (${selfieDoc.biometricMatchScore}%)`
                    : "Selfie — Not taken"}
            </span>
          </div>
          {/* Credit Agreement status */}
          {(() => {
            const agreeDoc = docs.find(d => d.docType === "CREDIT_AGREEMENT" && !d.deletedAt)
            return (
              <div
                className={`flex items-center gap-2 text-sm p-2 rounded ${
                  agreeDoc?.verified ? "bg-green-50" : agreeDoc ? "bg-amber-50" : "bg-gray-50"
                }`}
              >
                {agreeDoc?.verified ? (
                  <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                ) : agreeDoc ? (
                  <Clock className="h-4 w-4 text-amber-500 shrink-0" />
                ) : (
                  <FileText className="h-4 w-4 text-gray-400 shrink-0" />
                )}
                <span className={
                  agreeDoc?.verified ? "text-green-800"
                    : agreeDoc ? "text-amber-800"
                    : "text-gray-500"
                }>
                  {agreeDoc?.verified ? "Agreement Signed" : agreeDoc ? "Agreement — Awaiting signature" : "Credit Agreement — Not generated"}
                </span>
              </div>
            )
          })()}
        </div>
      </div>

      {/* Signing packet lifecycle — one card per application, above the folder
          because it is the thing staff act on. The halves and the returned copy
          sit collapsed below as the record. */}
      {packets.length > 0 && (
        <div className="space-y-3">
          {packets.map((packet) => renderPacketCard(packet))}
        </div>
      )}

      {/* Document grid */}
      {loading ? (
        <div className="text-center text-gray-400 py-8">Loading documents...</div>
      ) : primary.length === 0 ? (
        <div className="text-center text-gray-400 py-8">No documents uploaded yet</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {primary.map((doc) => renderDocumentCard(doc))}
        </div>
      )}

      {packetComponents.length > 0 && (
        <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50/50">
          <button
            type="button"
            onClick={() => setPacketComponentsOpen((open) => !open)}
            aria-expanded={packetComponentsOpen}
            className="flex w-full items-start justify-between gap-3 p-4 text-left"
          >
            <span>
              <span className="block text-sm font-medium text-gray-900">
                Signing packet components ({packetComponents.length})
              </span>
              <span className="mt-0.5 block text-xs text-gray-600">
                {SIGNING_PACKET_COMPONENT_NOTE}
              </span>
            </span>
            {packetComponentsOpen
              ? <ChevronUp className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
              : <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />}
          </button>
          {packetComponentsOpen && (
            <div className="grid grid-cols-1 gap-4 border-t border-blue-200 p-4 md:grid-cols-2">
              {packetComponents.map((doc) => renderDocumentCard(doc))}
            </div>
          )}
        </div>
      )}

      {!readOnly && (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          clientId={clientId}
          onUploadComplete={() => { fetchDocs(); router.refresh() }}
          hasIdDocument={hasIdDocument}
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
