"use client"

import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { AlertCircle, Camera, CheckCircle, Clock, Fingerprint, Loader2 } from "lucide-react"
import type { PortalKycChecklist } from "@/lib/kyc/portal-checklist"
import { useT } from "@/lib/i18n/client"

/** The selfie line of the documents checklist. */
export function SelfieChecklistRow({ selfie, matchScore, hasIdDocument, failureText, onTake }: {
  selfie: PortalKycChecklist["selfie"]
  /** The latest selfie's match score, when there is one. */
  matchScore: number | null | undefined
  hasIdDocument: boolean
  failureText: string
  onTake: () => void
}) {
  const t = useT("portalDocuments")
  // Identity attested in person: there is no selfie to take, so the row says
  // so and offers no capture (Fair Score audit 2026-10-16: it read REQUIRED).
  if (selfie.status === "verified_in_person") {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4 text-sm sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <CheckCircle className="h-5 w-5 shrink-0 text-[var(--cf-success)]" />
          <div className="min-w-0">
            <p className="font-semibold text-[var(--cf-text)]">{t("selfieTitle")}</p>
            <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">{t("selfieInPersonDetail")}</p>
          </div>
        </div>
        <StatusPill tone="success">{t("selfieNotNeeded")}</StatusPill>
      </div>
    )
  }

  const verified = selfie.status === "verified"
  const exceptionAccepted = selfie.status === "exception_accepted"
  const pending = selfie.status === "pending_review"
  // Nothing is running while staff review the ID copy: no spinner.
  const awaitingIdVerification = pending && selfie.awaitingIdVerification
  const failed = selfie.status === "action_required"

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4 text-sm sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {exceptionAccepted ? (
          <AlertCircle className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
        ) : verified ? (
          <Fingerprint className="h-5 w-5 shrink-0 text-[var(--cf-success)]" />
        ) : awaitingIdVerification ? (
          <Clock className="h-5 w-5 shrink-0 text-[var(--cf-info)]" />
        ) : pending ? (
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--cf-info)]" />
        ) : failed ? (
          <AlertCircle className="h-5 w-5 shrink-0 text-[var(--cf-danger)]" />
        ) : (
          <Camera className="h-5 w-5 shrink-0 text-[var(--cf-warning)]" />
        )}
        <div className="min-w-0">
          <p className="font-semibold text-[var(--cf-text)]">{t("selfieTitle")}</p>
          <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">
            {exceptionAccepted
              ? t("selfieExceptionDetail")
              : verified
              ? t("selfieVerifiedDetail", { score: String(matchScore) })
              : pending
                ? selfie.awaitingIdVerification
                  ? t("selfieAwaitingId")
                  : selfie.reason === "document_not_verified"
                  ? t("selfieChecksPassed")
                  : t("selfieReceived")
                : failed
                  ? failureText
                  : hasIdDocument
                    ? t("selfieTake")
                    : t("selfieIdFirst")}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        {exceptionAccepted ? (
          <StatusPill tone="warning">{t("seniorException")}</StatusPill>
        ) : verified ? (
          <StatusPill tone="success">{t("verifiedScore", { score: String(matchScore) })}</StatusPill>
        ) : pending ? (
          <StatusPill tone="info">
            {selfie.reason === "document_not_verified" || selfie.awaitingIdVerification
              ? t("pendingReview")
              : t("verifying")}
          </StatusPill>
        ) : failed ? (
          <StatusPill tone="danger">{t("actionNeeded")}</StatusPill>
        ) : (
          <StatusPill tone="warning">{t("required")}</StatusPill>
        )}
        <Button variant={verified || exceptionAccepted ? "outline" : "default"} size="sm" onClick={onTake}>
          {verified || exceptionAccepted || failed
            ? t("retake")
            : pending
              ? t("replace")
              : t("takeSelfie")}
        </Button>
      </div>
    </div>
  )
}
