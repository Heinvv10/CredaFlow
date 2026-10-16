"use client"

import { useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Camera, CheckCircle, XCircle, Loader2, RotateCcw, AlertCircle, UserCheck, UserX } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"
import {
  BIOMETRIC_AWAITING_ID_VERIFICATION_COPY,
  biometricFailureCopy,
} from "@/lib/kyc/biometric-failure-copy"
import {
  MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
  MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
  hasMinimumManualKycExceptionCharacters,
} from "@/lib/kyc/manual-exception-policy"
import {
  IN_PERSON_KYC_VERIFICATION_METHODS,
  IN_PERSON_KYC_VERIFICATION_METHOD_LABELS,
  IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
  inPersonKycVerificationOffered,
  type InPersonKycVerificationMethod,
  type InPersonRouteState,
} from "@/lib/kyc/in-person-verification"
import type { KycOverrideMinRole, KycOverrideRefusalCode } from "@/lib/kyc/override-policy"

type KycStatus = "PENDING" | "VERIFIED" | "FAILED" | "EXPIRED"

interface SelfieDoc {
  id: string
  fileName: string
  mimeType: string | null
  deletedAt: string | null
  biometricMatchScore: number | null
  biometricLiveness: number | null
  biometricVerifiedAt: string | null
  extractionStatus: string
  verifiedAt: string | null
  verificationNote: string | null
  createdAt: string
}

interface Props {
  clientId: string
  currentKycStatus: KycStatus
  currentManualRejectionActive: boolean
  currentManualRejectionReason: string | null
  selfieDoc: SelfieDoc | null
  imageUrl: string | null
  currentManualException?: ManualExceptionSummary | null
  canGrantManualException?: boolean
  canRecordInPersonVerification?: boolean
  canDecideOverrideRequest?: boolean
  overrideRefusalCode?: KycOverrideRefusalCode | null
  inPersonOverrideRefusalCode?: KycOverrideRefusalCode | null
  overrideMinRole?: KycOverrideMinRole
  secondApproverRequired?: boolean
  currentUserId?: string | null
  pendingOverrideRequests?: PendingOverrideRequest[]
  currentInPersonVerification?: InPersonVerificationSummary | null
  coreDocumentsComplete?: boolean
  /**
   * The composite gate's own verdict on the latest attempt. The tab used to
   * re-derive this from `extractionStatus === "failed"`, which disagrees with
   * the gate: a quarantined attempt keeps status "done", so the tab showed
   * neither fallback while the API would have accepted an in-person one.
   *
   * Required, not defaulted: a default would restore exactly the failure this
   * fixes — a caller that omits it renders "nothing wrong" over a refused
   * attempt. Required makes the compiler name every caller instead.
   */
  biometricEvidence: string | null
  biometricAttemptFailed: boolean
  /**
   * The latest selfie matched the client's current ID copy, which staff have
   * not verified yet. Not a failed attempt: the remedy is verifying that copy.
   */
  biometricAwaitingIdVerification: boolean
  /**
   * The in-person route's evidence preconditions, derived on the server by
   * readCompositeKycState, so the form is offered exactly when the route
   * would grant.
   */
  inPersonRoute: InPersonRouteState
  /**
   * Whether the senior-exception route would actually accept this attempt.
   * Derived on the server with `isManualKycExceptionableAttempt` — the same
   * helper the granting route enforces with — so the tab cannot offer an
   * action the API refuses, and the rule is not duplicated here by halves.
   */
  seniorExceptionAvailable: boolean
  /** View only: no selfie capture and no KYC approve/reject. */
  readOnly?: boolean
}

interface PendingOverrideRequest {
  id: string
  kind: "EXCEPTION" | "IN_PERSON"
  requestedById: string
  requestedAt: string
  expiresAt: string
  requestedBy: { email: string; name: string | null }
}

interface InPersonVerificationSummary {
  method: InPersonKycVerificationMethod
  note: string
  approvedAt: string
  approvedByEmail: string
}

interface ManualExceptionSummary {
  reason: string
  supportingEvidence: string
  biometricFailureReason: string
  approvedAt: string
  approvedByEmail: string
}

export function SelfieKycTab({
  clientId,
  currentKycStatus,
  currentManualRejectionActive,
  currentManualRejectionReason,
  selfieDoc,
  imageUrl,
  currentManualException = null,
  canGrantManualException = false,
  canRecordInPersonVerification = canGrantManualException,
  canDecideOverrideRequest = false,
  overrideRefusalCode = null,
  inPersonOverrideRefusalCode = null,
  overrideMinRole = "ADMIN",
  secondApproverRequired = false,
  currentUserId = null,
  pendingOverrideRequests = [],
  currentInPersonVerification = null,
  coreDocumentsComplete = false,
  biometricEvidence,
  biometricAttemptFailed,
  biometricAwaitingIdVerification,
  inPersonRoute,
  seniorExceptionAvailable,
  readOnly = false,
}: Props) {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [inPersonMethod, setInPersonMethod] = useState<InPersonKycVerificationMethod | "">("")
  const [inPersonNote, setInPersonNote] = useState("")
  const [recordingInPerson, setRecordingInPerson] = useState(false)
  const [mode, setMode] = useState<"view" | "capture">("view")
  const [streaming, setStreaming] = useState(false)
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadDone, setUploadDone] = useState(false)
  const [updatingKyc, setUpdatingKyc] = useState(false)
  const [kycStatus, setKycStatus] = useState<KycStatus>(currentKycStatus)
  // A sibling can change the stored status and router.refresh() (Re-verify ID
  // on the KYC checklist): take the refreshed server value when it changes.
  const [serverKycStatus, setServerKycStatus] = useState<KycStatus>(currentKycStatus)
  if (currentKycStatus !== serverKycStatus) {
    setServerKycStatus(currentKycStatus)
    setKycStatus(currentKycStatus)
  }
  const [manualRejectionActive, setManualRejectionActive] = useState(
    currentManualRejectionActive,
  )
  const [manualRejectionReason, setManualRejectionReason] = useState(
    currentManualRejectionReason,
  )
  const [error, setError] = useState<string | null>(null)
  const [manualException, setManualException] =
    useState<ManualExceptionSummary | null>(currentManualException)
  const [exceptionReason, setExceptionReason] = useState("")
  const [exceptionEvidence, setExceptionEvidence] = useState("")
  const [grantingException, setGrantingException] = useState(false)

  const startCamera = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setStreaming(true)
    } catch {
      setError("Camera access denied. Please allow camera permission and try again.")
    }
  }, [])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStreaming(false)
  }, [])

  const capturePhoto = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      setCapturedBlob(blob)
      setCapturedUrl(URL.createObjectURL(blob))
      stopCamera()
    }, "image/jpeg", 0.9)
  }, [stopCamera])

  const retake = () => {
    setCapturedBlob(null)
    setCapturedUrl(null)
    startCamera()
  }

  const uploadSelfie = async () => {
    if (!capturedBlob) return
    setUploading(true)
    setError(null)
    try {
      const formData = new FormData()
      formData.append("image", capturedBlob, "selfie.jpg")
      formData.append("clientId", clientId)
      const res = await fetch("/api/documents/selfie", { method: "POST", body: formData })
      if (res.ok) {
        setUploadDone(true)
        setCapturedBlob(null)
        setMode("view")
      } else {
        const data = await res.json() as { error?: string }
        setError(data.error ?? "Upload failed")
      }
    } catch {
      setError("Network error — please try again")
    } finally {
      setUploading(false)
    }
  }

  const updateKycStatus = async (status: "VERIFIED" | "FAILED") => {
    const rejectionReason = status === "FAILED"
      ? window.prompt("Enter the reason for manually rejecting this KYC (minimum 10 characters):")?.trim()
      : undefined
    if (status === "FAILED" && (!rejectionReason || rejectionReason.length < 10)) {
      setError("A manual KYC rejection reason of at least 10 characters is required.")
      return
    }
    const resolutionReason = status === "VERIFIED" && manualRejectionActive
      ? window.prompt("Enter the reason for resolving the manual KYC rejection (minimum 10 characters):")?.trim()
      : undefined
    if (
      status === "VERIFIED" &&
      manualRejectionActive &&
      (!resolutionReason || resolutionReason.length < 10)
    ) {
      setError("A manual KYC resolution reason of at least 10 characters is required.")
      return
    }

    setUpdatingKyc(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kycStatus: status,
          kycVerificationMethod: status === "VERIFIED" ? "DIGITAL" : undefined,
          reason: rejectionReason,
          resolveManualRejection: status === "VERIFIED" && manualRejectionActive,
          resolutionReason,
        }),
      })
      if (res.ok) {
        const updated = await res.json() as {
          kycStatus: KycStatus
          kycManualRejectionActive: boolean
          kycManualRejectionReason: string | null
        }
        setKycStatus(updated.kycStatus)
        setManualRejectionActive(updated.kycManualRejectionActive)
        setManualRejectionReason(updated.kycManualRejectionReason)
      } else {
        // The route names the precise blocker in `biometricEvidence`. Printing
        // only `error` gave staff the whole 60-word rule and no way to tell
        // which half of it they had failed.
        const data = (await res.json().catch(() => ({}))) as {
          error?: string
          biometricEvidence?: string | null
        }
        const blocker = biometricFailureCopy(data.biometricEvidence)
        setError([
          data.error ?? "Could not update KYC status. Please try again.",
          blocker
            ? `${blocker.label}: ${blocker.detail}`
            : data.biometricEvidence
              ? "Identity not verified: this selfie is not currently valid evidence."
              : null,
        ].filter(Boolean).join(" "))
      }
    } catch {
      setError("Network error — please try again")
    } finally {
      setUpdatingKyc(false)
    }
  }

  const recordInPersonVerification = async () => {
    if (!inPersonMethod) return
    setRecordingInPerson(true)
    setError(null)
    try {
      const res = await fetch(secondApproverRequired
        ? `/api/clients/${clientId}/kyc-override-requests`
        : `/api/clients/${clientId}/kyc-in-person-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(secondApproverRequired ? { kind: "IN_PERSON" } : {}),
          method: inPersonMethod,
          note: inPersonNote,
        }),
      })
      if (res.ok) {
        router.refresh()
        return
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      setError(data.error ?? "Could not record the in-person verification.")
    } catch {
      setError("Network error — please try again")
    } finally {
      setRecordingInPerson(false)
    }
  }

  const grantManualException = async () => {
    setGrantingException(true)
    setError(null)
    try {
      const res = await fetch(secondApproverRequired
        ? `/api/clients/${clientId}/kyc-override-requests`
        : `/api/clients/${clientId}/kyc-exception`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(secondApproverRequired ? { kind: "EXCEPTION" } : {}),
          reason: exceptionReason,
          supportingEvidence: exceptionEvidence,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        kycStatus?: KycStatus
        manualException?: ManualExceptionSummary
      }
      if (!res.ok) {
        setError(data.error ?? "Could not grant the KYC exception.")
        return
      }
      if (!secondApproverRequired) {
        setKycStatus(data.kycStatus ?? "VERIFIED")
        setManualException(data.manualException ?? null)
      }
      setExceptionReason("")
      setExceptionEvidence("")
      router.refresh()
    } catch {
      setError("Network error — please try again")
    } finally {
      setGrantingException(false)
    }
  }

  const decideRequest = async (requestId: string, decision: "APPROVED" | "DECLINED") => {
    const reason = window.prompt(`Enter the reason for this ${decision.toLowerCase()} decision (minimum 20 characters):`)?.trim()
    if (!reason || Array.from(reason).length < 20) {
      setError("A decision reason of at least 20 characters is required.")
      return
    }
    setError(null)
    try {
      const response = await fetch(`/api/clients/${clientId}/kyc-override-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) {
        setError(data.error ?? "Could not decide the override request.")
        return
      }
      router.refresh()
    } catch {
      setError("Network error — please try again")
    }
  }

  const roleWithArticle = overrideMinRole === "BRANCH_MANAGER" ? "A Branch Manager" : "An Admin"
  const refusalNote = (code: KycOverrideRefusalCode | null) => {
    if (code === "role_below_policy") return `${roleWithArticle} or more senior role is required.`
    if (code === "totp_required") return "Sign out and back in with two-factor authentication to perform this override."
    if (code === "overrides_disabled") return "KYC overrides are disabled for this lender."
    return null
  }

  const failureCopy = biometricFailureCopy(biometricEvidence)

  const kycBadgeClass = manualException
    ? "bg-amber-100 text-amber-900"
    : {
    PENDING: "bg-amber-100 text-amber-800",
    VERIFIED: "bg-green-100 text-green-800",
    FAILED: "bg-red-100 text-red-800",
    EXPIRED: "bg-gray-100 text-gray-800",
      }[kycStatus]
  const kycBadgeLabel = manualException ? "MANUAL EXCEPTION" : kycStatus

  // Shared with the upload dialog's selfie step, which points staff here. If
  // this is false the pointer is not shown, so the two surfaces cannot
  // disagree about whether the form is on the page.
  const inPersonFormOffered = inPersonKycVerificationOffered({
    manualExceptionActive: Boolean(manualException),
    inPersonVerificationRecorded: Boolean(currentInPersonVerification),
    coreDocumentsComplete,
    manualRejectionActive: currentManualRejectionActive,
    ...inPersonRoute,
  })

  const inPersonVerificationForm = inPersonFormOffered ? (
    <>
            {canRecordInPersonVerification ? (
              <div className="mt-4 space-y-3 border-t border-amber-300 pt-4">
                <p className="font-semibold">{overrideMinRole === "ADMIN" ? "ADMIN-only in-person verification" : "Senior in-person verification"}</p>
                <label className="block">
                  <span className="text-xs font-medium">How was identity verified?</span>
                  <select
                    value={inPersonMethod}
                    onChange={(event) =>
                      setInPersonMethod(event.target.value as InPersonKycVerificationMethod | "")
                    }
                    className="mt-1 w-full rounded border border-amber-300 bg-white p-2 text-sm"
                  >
                    <option value="">Select a method…</option>
                    {IN_PERSON_KYC_VERIFICATION_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {IN_PERSON_KYC_VERIFICATION_METHOD_LABELS[method]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-medium">
                    What did you verify? (minimum{" "}
                    {IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS} characters)
                  </span>
                  <textarea
                    value={inPersonNote}
                    onChange={(event) => setInPersonNote(event.target.value)}
                    className="mt-1 min-h-20 w-full rounded border border-amber-300 bg-white p-2 text-sm"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  onClick={recordInPersonVerification}
                  disabled={
                    recordingInPerson ||
                    !inPersonMethod ||
                    !hasMinimumManualKycExceptionCharacters(
                      inPersonNote,
                      IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
                    )
                  }
                  className="bg-amber-700 text-white hover:bg-amber-800"
                >
                  {recordingInPerson ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <UserCheck className="mr-1.5 h-4 w-4" />
                  )}
                  {secondApproverRequired ? "Request in-person verification" : "Record in-person verification"}
                </Button>
              </div>
            ) : (
              <p className="mt-3 font-medium">
                {refusalNote(inPersonOverrideRefusalCode) ?? `${roleWithArticle} or more senior role must record this verification.`}
              </p>
            )}
    </>
  ) : null

  return (
    <div className="space-y-6">
      {/* KYC Status + Admin Controls */}
      {/* Linked to from the selfie step of the document upload dialog, which is
          on a different tab — the id is the link target, not decoration. */}
      <div id="kyc-identity-verification" className="scroll-mt-24 bg-white rounded-lg border border-[#e5e7eb] p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-[#1b1d24]">KYC Status</h3>
          <span className={`px-3 py-1 rounded-full text-sm font-semibold ${kycBadgeClass}`}>{kycBadgeLabel}</span>
        </div>
        {!readOnly && (
          <div className="flex gap-3">
            <Button
              size="sm"
              onClick={() => updateKycStatus("VERIFIED")}
              disabled={updatingKyc || kycStatus === "VERIFIED"}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {updatingKyc ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <UserCheck className="h-4 w-4 mr-1.5" />}
              Approve KYC
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateKycStatus("FAILED")}
              disabled={updatingKyc || manualRejectionActive}
              className="border-red-300 text-red-600 hover:bg-red-50"
            >
              {updatingKyc ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <UserX className="h-4 w-4 mr-1.5" />}
              Reject KYC
            </Button>
          </div>
        )}
        {manualRejectionActive && (
          <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium">Manual KYC rejection is active</p>
            <p className="mt-1">{manualRejectionReason}</p>
          </div>
        )}
        {manualException ? (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">Senior manual exception — not a biometric pass</p>
            <p className="mt-1">
              Automated result: {manualException.biometricFailureReason.replaceAll("_", " ")}
            </p>
            <p className="mt-2"><span className="font-medium">Reason:</span> {manualException.reason}</p>
            <p className="mt-1"><span className="font-medium">Supporting evidence:</span> {manualException.supportingEvidence}</p>
            <p className="mt-2 text-xs text-amber-800">
              Approved by {manualException.approvedByEmail} on{" "}
              {new Date(manualException.approvedAt).toLocaleString("en-ZA", {
                timeZone: SAST_TIME_ZONE,
              })}
            </p>
          </div>
        ) : currentInPersonVerification ? (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">Verified in person — no biometric was captured</p>
            <p className="mt-1">
              {IN_PERSON_KYC_VERIFICATION_METHOD_LABELS[currentInPersonVerification.method]}
            </p>
            <p className="mt-2">
              <span className="font-medium">What was verified:</span>{" "}
              {currentInPersonVerification.note}
            </p>
            <p className="mt-2 text-xs text-amber-800">
              Recorded by {currentInPersonVerification.approvedByEmail} on{" "}
              {new Date(currentInPersonVerification.approvedAt).toLocaleString("en-ZA", {
                timeZone: SAST_TIME_ZONE,
              })}
              . Lapses automatically if the ID document or the client&apos;s identity changes.
            </p>
          </div>
        ) : null}
        {pendingOverrideRequests.map((request) => (
          <div key={request.id} className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">Pending {request.kind === "EXCEPTION" ? "selfie exception" : "in-person verification"} request</p>
            <p className="mt-1">
              Requested by {request.requestedBy.name ?? request.requestedBy.email} on{" "}
              {new Date(request.requestedAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}; expires{" "}
              {new Date(request.expiresAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}.
            </p>
            {request.requestedById === currentUserId ? (
              <p className="mt-2 font-medium">Awaiting another approver.</p>
            ) : canDecideOverrideRequest ? (
              <div className="mt-3 flex gap-2">
                {(
                  request.kind === "EXCEPTION"
                    ? canGrantManualException
                    : canRecordInPersonVerification
                ) && (
                  <Button size="sm" type="button" onClick={() => void decideRequest(request.id, "APPROVED")}>Approve</Button>
                )}
                <Button size="sm" type="button" variant="outline" onClick={() => void decideRequest(request.id, "DECLINED")}>Decline</Button>
              </div>
            ) : null}
          </div>
        ))}
        {!manualException && !currentInPersonVerification && !selfieDoc && coreDocumentsComplete && !currentManualRejectionActive ? (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">No selfie captured</p>
            <p className="mt-1">
              A verified ID proves the document is real, not that this applicant is
              its subject. Capture a selfie, or record an in-person verification.
            </p>
{inPersonVerificationForm}
          </div>
        ) : biometricAttemptFailed ? (
          <div className="mt-4 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            <p className="font-semibold">
              {failureCopy?.label ?? "Identity not verified"}
            </p>
            {failureCopy && <p className="mt-1">{failureCopy.detail}</p>}
            <p className="mt-1">
              The ordinary Approve KYC action cannot bypass this.
            </p>
            {overrideRefusalCode === "clear_mismatch" ? (
              <p className="mt-3 font-semibold">
                Faces clearly don&apos;t match — this can&apos;t be overridden. Ask the client for a new selfie, or verify them in person.
              </p>
            ) : !seniorExceptionAvailable ? (
              <p className="mt-3">
                A senior exception applies only where the check ran against the
                ID photograph and returned an adverse result, so it does not
                apply here. Re-capture the selfie, or record an in-person
                verification below.
              </p>
            ) : canGrantManualException ? (
              <div className="mt-4 space-y-3 border-t border-red-200 pt-4">
                <p className="font-semibold">{overrideMinRole === "ADMIN" ? "ADMIN-only senior exception" : "Senior KYC exception"}</p>
                <label className="block">
                  <span className="text-xs font-medium">
                    Reason (minimum {MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS} characters)
                  </span>
                  <textarea
                    value={exceptionReason}
                    onChange={(event) => setExceptionReason(event.target.value)}
                    className="mt-1 min-h-20 w-full rounded border border-red-300 bg-white p-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium">
                    Supporting evidence (minimum {MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS} characters)
                  </span>
                  <textarea
                    value={exceptionEvidence}
                    onChange={(event) => setExceptionEvidence(event.target.value)}
                    className="mt-1 min-h-20 w-full rounded border border-red-300 bg-white p-2 text-sm"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  onClick={grantManualException}
                  disabled={
                    grantingException ||
                    !hasMinimumManualKycExceptionCharacters(
                      exceptionReason,
                      MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
                    ) ||
                    !hasMinimumManualKycExceptionCharacters(
                      exceptionEvidence,
                      MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
                    )
                  }
                  className="bg-amber-700 text-white hover:bg-amber-800"
                >
                  {grantingException ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <AlertCircle className="mr-1.5 h-4 w-4" />
                  )}
                  {secondApproverRequired ? "Request override" : "Grant senior KYC exception"}
                </Button>
              </div>
            ) : (
              <p className="mt-3 font-medium">
                {refusalNote(overrideRefusalCode) ?? `${roleWithArticle} or more senior role must review any exception.`}
              </p>
            )}
            <div className="mt-4 border-t border-red-200 pt-4">
              <p className="text-sm">
                Alternatively, a failed attempt does not close the human
                fallback: an ADMIN can verify this client in person.
              </p>
              {inPersonVerificationForm}
            </div>
          </div>
        ) : biometricAwaitingIdVerification ? (
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">{BIOMETRIC_AWAITING_ID_VERIFICATION_COPY.label}</p>
            <p className="mt-1">{BIOMETRIC_AWAITING_ID_VERIFICATION_COPY.detail}</p>
          </div>
        ) : null}
      </div>

      {/* Existing Selfie */}
      {(selfieDoc || imageUrl || uploadDone) && mode === "view" && (
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5">
          <h3 className="font-semibold text-[#1b1d24] mb-4">Latest Selfie Attempt</h3>
          {selfieDoc?.deletedAt && (
            <div
              role="alert"
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            >
              <p className="font-medium">The authoritative latest selfie attempt was deleted.</p>
              <p className="mt-1">
                Older attempts are not current KYC evidence. Capture a new selfie before
                approving or progressing this client.
              </p>
            </div>
          )}
          {uploadDone && !selfieDoc && (
            <div className="bg-green-50 border border-green-200 rounded p-3 flex items-center gap-2 mb-4">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <p className="text-sm text-green-700">Selfie uploaded. Biometric verification is processing...</p>
            </div>
          )}
          {imageUrl && !selfieDoc?.deletedAt && (
            <div className="flex gap-6 items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="Client selfie" className="w-40 h-40 object-cover rounded-lg border" />
              {selfieDoc && (
                <div className="text-sm space-y-2">
                  <p><span className="text-gray-500">Uploaded:</span> {new Date(selfieDoc.createdAt).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })}</p>
                  <p><span className="text-gray-500">Extraction:</span> {selfieDoc.extractionStatus}</p>
                  {selfieDoc.biometricMatchScore !== null && (
                    <p>
                      <span className="text-gray-500">Match Score:</span>{" "}
                      <span className={selfieDoc.biometricMatchScore >= 70 ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                        {selfieDoc.biometricMatchScore}%
                      </span>
                    </p>
                  )}
                  {selfieDoc.biometricLiveness !== null && (
                    <p><span className="text-gray-500">Liveness:</span> {selfieDoc.biometricLiveness}%</p>
                  )}
                  {selfieDoc.biometricVerifiedAt && biometricEvidence === null && (
                    <p className="flex items-center gap-1.5 text-green-700">
                      <CheckCircle className="h-4 w-4" />Biometrically verified
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Camera Capture */}
      {!readOnly && (
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-[#1b1d24]">Capture New Selfie</h3>
            {mode === "view" && (
              <Button size="sm" onClick={() => { setMode("capture"); startCamera() }}>
                <Camera className="h-4 w-4 mr-1.5" />Open Camera
              </Button>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm mb-4 bg-red-50 border border-red-200 rounded p-3">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {mode === "capture" && (
            <div className="space-y-4">
              {!capturedUrl ? (
                <>
                  <div className="relative bg-black rounded-lg overflow-hidden" style={{ aspectRatio: "4/3", maxHeight: "400px" }}>
                    <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                    {!streaming && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="h-8 w-8 text-white animate-spin" />
                      </div>
                    )}
                    {/* Face guide oval */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="w-44 h-56 border-2 border-white border-dashed rounded-full opacity-60" />
                    </div>
                  </div>
                  <canvas ref={canvasRef} className="hidden" />
                  <div className="flex gap-3">
                    <Button onClick={capturePhoto} disabled={!streaming}>
                      <Camera className="h-4 w-4 mr-1.5" />Capture Photo
                    </Button>
                    <Button variant="ghost" onClick={() => { stopCamera(); setMode("view") }}>Cancel</Button>
                  </div>
                  <p className="text-xs text-gray-400">Position your face within the oval. Ensure good lighting.</p>
                </>
              ) : (
                <>
                  <div className="rounded-lg overflow-hidden border" style={{ maxWidth: "320px" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={capturedUrl} alt="Captured selfie" className="w-full" />
                  </div>
                  <div className="flex gap-3">
                    <Button onClick={uploadSelfie} disabled={uploading}>
                      {uploading ? (
                        <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Uploading...</>
                      ) : (
                        <><CheckCircle className="h-4 w-4 mr-1.5" />Use This Photo</>
                      )}
                    </Button>
                    <Button variant="ghost" onClick={retake} disabled={uploading}>
                      <RotateCcw className="h-4 w-4 mr-1.5" />Retake
                    </Button>
                    <Button variant="ghost" onClick={() => { setMode("view"); setCapturedBlob(null); setCapturedUrl(null) }} disabled={uploading}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {mode === "view" && !selfieDoc && !uploadDone && (
            <div className="text-center py-8 text-gray-400">
              <XCircle className="h-10 w-10 mx-auto mb-2 text-gray-300" />
              <p className="text-sm">No selfie on file</p>
              <p className="text-xs mt-1">Click &quot;Open Camera&quot; to capture and upload a selfie</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
