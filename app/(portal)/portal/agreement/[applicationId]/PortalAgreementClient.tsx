"use client"

import { AGREEMENT_DECLARATIONS, AGREEMENT_DECLARATION_PAYLOAD } from "@/lib/signing/agreement-declaration-set"

import { useRef, useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { CheckCircle, Loader2, PenLine, Keyboard, RotateCcw } from "lucide-react"
import { toast } from "@/lib/toast"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { SigningOtpStep, type SigningOtpChannel } from "@/components/signing/SigningOtpStep"

const NO_SIGNING_OTP = { required: false, channels: [] as SigningOtpChannel[] }

interface Props {
  applicationId: string
  reference: string
  clientName: string
  /** Digest of the agreement rendered for this page load — echoed at signing
   * so a regeneration can never be signed over unseen bytes. */
  agreementDocumentSha256: string | null
  /** The executed artifact carrying both signatures, once countersigned. */
  agreementExecutedDocumentId: string | null
  pasqDocumentSha256: string | null
  repaymentMethod: "EFT" | "DEBIT_ORDER" | null
  /** The lender requires a verified one-time code before signing (lib/signing-otp). */
  signingOtp?: { required: boolean; channels: SigningOtpChannel[] }
}

type SignMode = "draw" | "type"

/**
 * Shown straight after the borrower signs. Only their signature exists at this
 * point: the executed agreement is minted when the credit provider
 * countersigns, and the signing packet URL serves the UNSIGNED PASQ and
 * agreement. So until the executed document exists there is nothing to
 * download that the borrower signed, and none is offered.
 */
export function AgreementSignedPanel({ applicationId, agreementExecutedDocumentId, mandateRequired }: {
  applicationId: string
  agreementExecutedDocumentId: string | null
  mandateRequired: boolean
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-center">
      <div className="bg-green-50 border border-green-200 rounded-lg p-8">
        <CheckCircle className="h-12 w-12 text-green-600 mx-auto mb-4" />
        <p className="text-2xl font-bold text-green-800 mb-2">Agreement signed</p>
        <p className="text-green-700">
          {mandateRequired
            ? "One step remains: confirm your repayment account and sign the debit mandate."
            : "Your repayments are set to EFT. No debit mandate is required."}
        </p>
        <div className="mt-6 flex justify-center gap-4 text-sm">
          {agreementExecutedDocumentId ? (
            <a
              href={`/api/documents/${agreementExecutedDocumentId}/view?download=1`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-green-700 underline hover:text-green-900"
            >
              Download signed agreement
            </a>
          ) : (
            <p className="text-green-700">
              Your signed copy will be available to download once we countersign your agreement.
            </p>
          )}
          <a
            href={
              mandateRequired
                ? `/portal/mandate/${applicationId}`
                : `/portal/applications/${applicationId}`
            }
            className="font-semibold text-green-900 underline"
          >
            {mandateRequired ? "Set up repayment" : "View application"}
          </a>
        </div>
      </div>
    </div>
  )
}

export function PortalAgreementClient({ applicationId, reference, clientName, agreementDocumentSha256, agreementExecutedDocumentId, pasqDocumentSha256, repaymentMethod, signingOtp = NO_SIGNING_OTP }: Props) {
  const [checks, setChecks] = useState([false, false, false, false, false])
  const [otpChallengeId, setOtpChallengeId] = useState<string | null>(null)
  // Remounts the OTP step after a signing refusal that spent or voided the code.
  const [otpAttempt, setOtpAttempt] = useState(0)
  const otpSatisfied = !signingOtp.required || otpChallengeId !== null
  const [signing, setSigning] = useState(false)
  const [signed, setSigned] = useState(false)
  const [signMode, setSignMode] = useState<SignMode>("draw")
  const [typedName, setTypedName] = useState("")
  const [hasDrawn, setHasDrawn] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawingRef = useRef(false)

  const allChecked = checks.every(Boolean)
  const hasSignature = signMode === "type" ? typedName.trim().length > 2 : hasDrawn
  const mandateRequired = repaymentMethod !== "EFT"

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.strokeStyle = "#1a1a1a"
    ctx.lineWidth = 2.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
  }, [signMode])

  function getPos(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect()
    // The pointer reports CSS pixels; the 2D context draws in BACKING-STORE
    // pixels. This canvas is 700x160 but rendered `w-full` — about 1641 wide on
    // a desktop — so an unscaled coordinate puts the ink roughly 2.3x further
    // right and down than the cursor, and off the canvas entirely past a third
    // of the way across. The consumer sees their signature refuse to follow
    // their finger.
    //
    // Both sibling pads already scale (PortalDebitMandateClient, and the staff
    // pad in components/applications/AgreementSection). This one did not.
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const point = "touches" in e ? e.touches[0] : e
    return {
      x: (point.clientX - rect.left) * scaleX,
      y: (point.clientY - rect.top) * scaleY,
    }
  }

  function onPointerDown(e: React.MouseEvent | React.TouchEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    isDrawingRef.current = true
    const { x, y } = getPos(e, canvas)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function onPointerMove(e: React.MouseEvent | React.TouchEvent) {
    if (!isDrawingRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const { x, y } = getPos(e, canvas)
    ctx.lineTo(x, y)
    ctx.stroke()
    setHasDrawn(true)
  }

  function onPointerUp() {
    isDrawingRef.current = false
  }

  function clearCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasDrawn(false)
  }

  const toggle = (i: number) => setChecks(prev => prev.map((v, idx) => idx === i ? !v : v))

  const handleSign = async () => {
    if (!allChecked || !hasSignature || !otpSatisfied) return
    setSigning(true)
    try {
      let signatureData: string | undefined
      if (signMode === "draw" && canvasRef.current) {
        signatureData = canvasRef.current.toDataURL("image/png")
      } else if (signMode === "type") {
        signatureData = typedName.trim()
      }

      const res = await fetch(`/api/applications/${applicationId}/agreement/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "portal",
          declarations: AGREEMENT_DECLARATION_PAYLOAD,
          signature: signatureData,
          agreementDocumentSha256,
          pasqDocumentSha256,
          ...(otpChallengeId ? { signingOtpChallengeId: otpChallengeId } : {}),
        }),
      })
      if (res.ok) {
        setSigned(true)
        toast.agreement?.signed?.()
      } else {
        const data = await res.json() as { error?: string; signingOtp?: string }
        if (data.signingOtp) {
          setOtpChallengeId(null)
          setOtpAttempt((n) => n + 1)
        }
        toast.error?.("Signing failed", data.error ?? "Please try again")
      }
    } catch {
      toast.networkError?.()
    } finally {
      setSigning(false)
    }
  }

  if (signed) {
    return (
      <AgreementSignedPanel
        applicationId={applicationId}
        agreementExecutedDocumentId={agreementExecutedDocumentId}
        mandateRequired={mandateRequired}
      />
    )
  }

  const labels = AGREEMENT_DECLARATIONS.map(d => d.text)

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">PASQ + Credit Agreement</h1>
        <p className="text-sm text-gray-500 mt-1">{clientName} — Application {reference}</p>
      </div>

      {/* PDF viewer. Some devices (older mobile browsers, low memory) fail to
          render a PDF inside an iframe — the fallback link always works and lets
          the consumer read the agreement in their native PDF viewer before
          signing. Signing does not depend on the iframe rendering. */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-700">Signing packet — PASQ first, credit agreement second</p>
        <a
          href={`/api/applications/${applicationId}/signing-packet`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[#4F46E5] underline hover:text-[#3730a3]"
        >
          Open PDF in a new tab
        </a>
      </div>
      <div className="border rounded-lg overflow-hidden bg-gray-100" style={{ height: "60vh" }}>
        <iframe
          src={`/api/applications/${applicationId}/signing-packet`}
          className="w-full h-full"
          title="PASQ and Credit Agreement PDF"
        />
      </div>

      {/* Checkboxes */}
      <div className="bg-white rounded-lg shadow-sm p-6 space-y-4">
        <p className="font-semibold text-gray-900">Consumer Declaration</p>
        {labels.map((label, i) => (
          <label key={i} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={checks[i]}
              onChange={() => toggle(i)}
              className="mt-1 h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm text-gray-700">{label}</span>
          </label>
        ))}
      </div>

      {/* Signature capture */}
      <div className="bg-white rounded-lg shadow-sm p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-gray-900">Your Signature</p>
          <div className="flex gap-2">
            <button
              onClick={() => setSignMode("draw")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                signMode === "draw"
                  ? "bg-[#4F46E5] text-white border-[#4F46E5]"
                  : "text-gray-600 border-gray-300 hover:border-gray-400"
              }`}
            >
              <PenLine className="h-3.5 w-3.5" />Draw
            </button>
            <button
              onClick={() => setSignMode("type")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                signMode === "type"
                  ? "bg-[#4F46E5] text-white border-[#4F46E5]"
                  : "text-gray-600 border-gray-300 hover:border-gray-400"
              }`}
            >
              <Keyboard className="h-3.5 w-3.5" />Type
            </button>
          </div>
        </div>

        {signMode === "draw" ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">Draw your signature below using your mouse or finger</p>
            <div className="relative border-2 border-dashed border-gray-300 rounded-lg overflow-hidden" style={{ touchAction: "none" }}>
              <canvas
                ref={canvasRef}
                width={700}
                height={160}
                className="w-full cf-signature-pad cursor-crosshair"
                onMouseDown={onPointerDown}
                onMouseMove={onPointerMove}
                onMouseUp={onPointerUp}
                onMouseLeave={onPointerUp}
                onTouchStart={onPointerDown}
                onTouchMove={onPointerMove}
                onTouchEnd={onPointerUp}
              />
              {!hasDrawn && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-gray-300 text-sm">Sign here</p>
                </div>
              )}
            </div>
            {hasDrawn && (
              <button
                onClick={clearCanvas}
                className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
              >
                <RotateCcw className="h-3.5 w-3.5" />Clear signature
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">Type your full name as it appears on your ID</p>
            <input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="e.g. John Surname"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 font-['Georgia'] italic text-xl focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
            />
            <p className="text-xs text-gray-400">Date: {new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: SAST_TIME_ZONE })}</p>
          </div>
        )}
      </div>

      {signingOtp.required && (
        <SigningOtpStep
          key={otpAttempt}
          purpose="AGREEMENT"
          subjectId={applicationId}
          documentSha256={agreementDocumentSha256}
          channels={signingOtp.channels}
          onVerified={setOtpChallengeId}
        />
      )}

      <Button
        onClick={handleSign}
        disabled={!allChecked || !hasSignature || !otpSatisfied || signing}
        className="w-full py-6 text-lg"
        style={{ backgroundColor: allChecked && hasSignature && otpSatisfied ? "#4F46E5" : undefined }}
      >
        {signing ? (
          <><Loader2 className="h-5 w-5 mr-2 animate-spin" />Signing...</>
        ) : (
          <><CheckCircle className="h-5 w-5 mr-2" />I Accept and Sign Digitally</>
        )}
      </Button>
    </div>
  )
}
