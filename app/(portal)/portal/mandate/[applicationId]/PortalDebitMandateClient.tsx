"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import {
  CheckCircle,
  FileText,
  Keyboard,
  Loader2,
  PenLine,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { canonicalBankName } from "@/lib/banks"
import { useT } from "@/lib/i18n/client"
import { SigningOtpStep, type SigningOtpChannel } from "@/components/signing/SigningOtpStep"

type BankDetails = {
  bankName: string
  branchCode: string
  accountNumber: string
  accountType: "CHEQUE" | "SAVINGS"
}

type Props = {
  applicationId: string
  reference: string
  clientName: string
  initialBankDetails: BankDetails
  initialDraftSha256: string | null
  initiallySigned: boolean
  /** The lender requires a verified one-time code before signing (lib/signing-otp). */
  signingOtp?: { required: boolean; channels: SigningOtpChannel[] }
  /** The SAST date staff last reopened the application for review, if ever (lib/portal/return-to-review.ts). */
  returnedToReviewOn?: string | null
}

const NO_SIGNING_OTP = { required: false, channels: [] as SigningOtpChannel[] }

const BANKS = [
  "ABSA Bank",
  "African Bank",
  "Capitec Bank",
  "Discovery Bank",
  "FNB (First National Bank)",
  "Nedbank",
  "Standard Bank",
  "TymeBank",
  "Other",
]

// The client record may hold any spelling ("NEDBANK", "Capitec Bank Limited");
// pre-select the option that names the same bank, or leave the picker unset.
export function bankOption(stored: string): string {
  if (!stored.trim()) return ""
  const key = canonicalBankName(stored)
  return BANKS.find((name) => name !== "Other" && canonicalBankName(name) === key) ?? ""
}

const fieldClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-[#4F46E5]"

export function PortalDebitMandateClient({
  applicationId,
  reference,
  clientName,
  initialBankDetails,
  initialDraftSha256,
  initiallySigned,
  signingOtp = NO_SIGNING_OTP,
  returnedToReviewOn = null,
}: Props) {
  const t = useT("portalSigning")
  const [otpChallengeId, setOtpChallengeId] = useState<string | null>(null)
  // Remounts the OTP step after a signing refusal that spent or voided the code.
  const [otpAttempt, setOtpAttempt] = useState(0)
  const otpSatisfied = !signingOtp.required || otpChallengeId !== null
  const [bank, setBank] = useState({ ...initialBankDetails, bankName: bankOption(initialBankDetails.bankName) })
  const [draftSha256, setDraftSha256] = useState(initialDraftSha256)
  const [signed, setSigned] = useState(initiallySigned)
  const [preparing, setPreparing] = useState(false)
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checks, setChecks] = useState([false, false, false])
  const [signMode, setSignMode] = useState<"draw" | "type">("draw")
  const [typedName, setTypedName] = useState("")
  const [hasDrawn, setHasDrawn] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d")
    if (!context) return
    context.strokeStyle = "#1a1a1a"
    context.lineWidth = 2.5
    context.lineCap = "round"
    context.lineJoin = "round"
  }, [signMode, draftSha256])

  function pointerPosition(
    event: React.MouseEvent | React.TouchEvent,
    canvas: HTMLCanvasElement,
  ) {
    const rect = canvas.getBoundingClientRect()
    const point = "touches" in event ? event.touches[0] : event
    return {
      x: (point.clientX - rect.left) * (canvas.width / rect.width),
      y: (point.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  function pointerDown(event: React.MouseEvent | React.TouchEvent) {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    event.preventDefault()
    drawingRef.current = true
    const point = pointerPosition(event, canvas)
    context.beginPath()
    context.moveTo(point.x, point.y)
  }

  function pointerMove(event: React.MouseEvent | React.TouchEvent) {
    if (!drawingRef.current) return
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    event.preventDefault()
    const point = pointerPosition(event, canvas)
    context.lineTo(point.x, point.y)
    context.stroke()
    setHasDrawn(true)
  }

  function pointerUp() {
    drawingRef.current = false
  }

  function clearSignature() {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    setHasDrawn(false)
  }

  async function prepare() {
    setPreparing(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/applications/${applicationId}/debit-mandate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bank),
        },
      )
      const body = await response.json() as {
        error?: string
        draftDocumentSha256?: string
      }
      if (!response.ok || !body.draftDocumentSha256) {
        setError(body.error ?? t("mandateErrPrepare"))
        return
      }
      setDraftSha256(body.draftDocumentSha256)
      setChecks([false, false, false])
      clearSignature()
    } catch {
      setError(t("mandateErrNetwork"))
    } finally {
      setPreparing(false)
    }
  }

  async function sign() {
    if (!draftSha256 || !checks.every(Boolean) || !otpSatisfied) return
    const signature = signMode === "draw"
      ? canvasRef.current?.toDataURL("image/png")
      : typedName.trim()
    if (!signature) return
    setSigning(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/applications/${applicationId}/debit-mandate/sign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signature,
            draftDocumentSha256: draftSha256,
            ...(otpChallengeId ? { signingOtpChallengeId: otpChallengeId } : {}),
          }),
        },
      )
      const body = await response.json() as { error?: string; debitMandate?: string }
      if (!response.ok) {
        if (body.debitMandate?.startsWith("signing_otp_")) {
          setOtpChallengeId(null)
          setOtpAttempt((n) => n + 1)
        }
        setError(body.error ?? t("mandateErrSign"))
        return
      }
      setSigned(true)
    } catch {
      setError(t("mandateErrNetwork"))
    } finally {
      setSigning(false)
    }
  }

  if (signed) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="rounded-xl border border-green-200 bg-green-50 p-8 text-center">
          <CheckCircle className="mx-auto mb-4 h-12 w-12 text-green-600" />
          <h1 className="text-2xl font-bold text-green-900">{t("mandateSigned")}</h1>
          <p className="mt-2 text-sm text-green-800">{t("mandateRecorded", { reference })}</p>
          <div className="mt-6 flex justify-center gap-3">
            <Button asChild variant="outline">
              <a
                href={`/api/applications/${applicationId}/debit-mandate`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("mandateDownload")}
              </a>
            </Button>
            <Button asChild>
              <Link href={`/portal/applications/${applicationId}`}>
                {t("backToApplication")}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const signatureReady =
    signMode === "draw"
      ? hasDrawn
      : typedName.trim().toLocaleLowerCase("en-ZA")
        === clientName.trim().toLocaleLowerCase("en-ZA")

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("mandateTitle")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("mandateSubtitle", { reference })}</p>
      </div>

      {returnedToReviewOn && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-gray-800">
          <h2 className="font-semibold text-gray-900">Why you are signing again</h2>
          <p className="mt-1">
            On {returnedToReviewOn} we reopened your application for review. That cancelled what you had
            signed for it, the credit agreement and any debit order mandate, so we need your signature
            again on the terms now approved. Nothing will be collected under anything you signed before.
          </p>
        </section>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold text-gray-900">{t("mandateAccountHeading")}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label={t("fieldBank")}>
            <select
              className={fieldClass}
              value={bank.bankName}
              onChange={(event) => setBank({ ...bank, bankName: event.target.value })}
            >
              <option value="">{t("selectBank")}</option>
              {BANKS.map((name) => <option key={name}>{name}</option>)}
            </select>
          </Field>
          <Field label={t("fieldAccountType")}>
            <select
              className={fieldClass}
              value={bank.accountType}
              onChange={(event) => setBank({
                ...bank,
                accountType: event.target.value as BankDetails["accountType"],
              })}
            >
              <option value="CHEQUE">{t("accountCheque")}</option>
              <option value="SAVINGS">{t("accountSavings")}</option>
            </select>
          </Field>
          <Field label={t("fieldAccountNumber")}>
            <input
              className={fieldClass}
              inputMode="numeric"
              autoComplete="off"
              value={bank.accountNumber}
              onChange={(event) => setBank({
                ...bank,
                accountNumber: event.target.value.replace(/\D/g, "").slice(0, 16),
              })}
            />
          </Field>
          <Field label={t("fieldBranchCode")}>
            <input
              className={fieldClass}
              inputMode="numeric"
              value={bank.branchCode}
              onChange={(event) => setBank({
                ...bank,
                branchCode: event.target.value.replace(/\D/g, "").slice(0, 6),
              })}
            />
          </Field>
        </div>
        <Button
          className="mt-5"
          onClick={prepare}
          disabled={
            preparing
            || !bank.bankName
            || bank.branchCode.length !== 6
            || bank.accountNumber.length < 6
          }
        >
          {preparing
            ? <><Loader2 className="h-4 w-4 animate-spin" />{t("preparing")}</>
            : <><FileText className="h-4 w-4" />{t("prepareMandate")}</>}
        </Button>
      </section>

      {draftSha256 && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-gray-900">{t("reviewAuthority")}</h2>
              <a
                href={`/api/applications/${applicationId}/debit-mandate`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#4F46E5] underline"
              >
                {t("openPdf")}
              </a>
            </div>
            <div className="h-[60vh] overflow-hidden rounded-lg border bg-gray-100">
              <iframe
                key={draftSha256}
                title={t("mandateFrameTitle")}
                className="h-full w-full"
                src={`/api/applications/${applicationId}/debit-mandate`}
              />
            </div>
          </section>

          <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
            {[
              "I have read the debit authority and the first and recurring debit amounts.",
              "The banking details shown are mine and match my verified bank statement.",
              "I authorise the creditor to issue the payment instructions described in the mandate.",
            ].map((label, index) => (
              <label key={label} className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={checks[index]}
                  onChange={() => setChecks((current) =>
                    current.map((entry, item) =>
                      item === index ? !entry : entry,
                    ))}
                />
                <span className="text-sm text-gray-700">{label}</span>
              </label>
            ))}
          </section>

          <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">{t("signatureHeading")}</h2>
              <div className="flex gap-2">
                <ModeButton
                  active={signMode === "draw"}
                  onClick={() => setSignMode("draw")}
                >
                  <PenLine className="h-3.5 w-3.5" />{t("draw")}
                </ModeButton>
                <ModeButton
                  active={signMode === "type"}
                  onClick={() => setSignMode("type")}
                >
                  <Keyboard className="h-3.5 w-3.5" />{t("type")}
                </ModeButton>
              </div>
            </div>
            {signMode === "draw" ? (
              <div>
                <div
                  className="relative overflow-hidden rounded-lg border-2 border-dashed border-gray-300"
                  style={{ touchAction: "none" }}
                >
                  <canvas
                    ref={canvasRef}
                    width={700}
                    height={160}
                    className="w-full cf-signature-pad"
                    onMouseDown={pointerDown}
                    onMouseMove={pointerMove}
                    onMouseUp={pointerUp}
                    onMouseLeave={pointerUp}
                    onTouchStart={pointerDown}
                    onTouchMove={pointerMove}
                    onTouchEnd={pointerUp}
                  />
                </div>
                {hasDrawn && (
                  <button
                    type="button"
                    className="mt-2 flex items-center gap-1 text-xs text-gray-500"
                    onClick={clearSignature}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />{t("clear")}
                  </button>
                )}
              </div>
            ) : (
              <div>
                <input
                  className={`${fieldClass} font-['Georgia'] text-lg italic`}
                  value={typedName}
                  onChange={(event) => setTypedName(event.target.value)}
                  placeholder={clientName}
                />
                <p className="mt-2 text-xs text-gray-500">{t("typeExactly", { name: clientName })}</p>
              </div>
            )}
          </section>

          {signingOtp.required && (
            <SigningOtpStep
              key={`${draftSha256}:${otpAttempt}`}
              purpose="DEBIT_MANDATE"
              subjectId={applicationId}
              documentSha256={draftSha256}
              channels={signingOtp.channels}
              onVerified={setOtpChallengeId}
            />
          )}

          <Button
            className="w-full py-6 text-base"
            disabled={!checks.every(Boolean) || !signatureReady || !otpSatisfied || signing}
            onClick={sign}
          >
            {signing
              ? <><Loader2 className="h-5 w-5 animate-spin" />{t("signing")}</>
              : <><CheckCircle className="h-5 w-5" />Authorise and sign mandate</>}
          </Button>
        </>
      )}

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </span>
      {children}
    </label>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium ${
        active
          ? "border-[#4F46E5] bg-[#4F46E5] text-white"
          : "border-gray-300 text-gray-600"
      }`}
    >
      {children}
    </button>
  )
}
