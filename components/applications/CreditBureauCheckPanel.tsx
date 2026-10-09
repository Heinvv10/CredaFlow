import { AlertTriangle } from "lucide-react"
import type {
  BureauDisplay,
  BureauOverrideDisplay,
} from "@/lib/compliance/bureau-display"
import { formatDateTime, formatZAR } from "@/lib/utils"

interface Props {
  display: BureauDisplay
  bureauDebt: number | null
  selfDeclaredDebt: number
}

export function CreditBureauCheckPanel({ display, bureauDebt, selfDeclaredDebt }: Props) {
  if (display.kind === "MISSING") {
    return (
      <div className={`flex items-start gap-3 rounded-lg border p-4 ${display.immutable ? "border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] text-[var(--cf-danger)]" : "border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] text-[var(--cf-warning)]"}`}>
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="text-sm">
          {display.immutable
            ? "Immutable bureau decision evidence is missing. Current or historical bureau records are not substituted for the approval record. Return this application to review and reassess it before disbursement."
            : "No bureau check recorded. This may indicate the credit bureau is not configured or the check is still in progress."}
        </p>
      </div>
    )
  }

  if (display.kind === "SKIPPED") {
    const message =
      display.reason === "CONSENT_WITHDRAWN"
        ? "Bureau check skipped — client withdrew POPIA consent for credit bureau enquiry."
        : display.reason === "CONSENT_REFUSED"
          ? "Bureau check skipped — client did not grant consent for credit bureau enquiry."
          : "Bureau check skipped — no POPIA consent on file for credit bureau enquiry."
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-4 text-[var(--cf-warning)]">
        <AlertTriangle className="h-5 w-5 shrink-0" />
        <p className="text-sm">{message}</p>
      </div>
    )
  }

  if (display.kind === "PENDING") {
    return (
      <div className="rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-4 text-[var(--cf-warning)]">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <p className="text-sm">Bureau check failed or could not be completed. Review the credit bureau integration settings.</p>
        </div>
        {display.error && <p className="mt-1 text-xs text-amber-600">{display.error}</p>}
      </div>
    )
  }

  if (display.kind === "OVERRIDE") {
    return <BureauOverrideNotice override={display.override} />
  }

  const scoreColor = display.score === null
    ? "text-[var(--cf-text-muted)]"
    : display.score >= 650
      ? "text-[var(--cf-success)]"
      : display.score >= 500
        ? "text-[var(--cf-warning)]"
        : "text-[var(--cf-danger)]"

  return (
    <div className="space-y-4">
      {display.override && <BureauOverrideNotice override={display.override} />}
      {display.source === "APPROVAL_SNAPSHOT" && (
        <p className="text-xs font-medium text-[var(--cf-text-muted)]">Evidence source: immutable approval snapshot</p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
          <p className="text-sm text-[var(--cf-text-muted)]">Provider</p>
          <p className="font-semibold capitalize text-[var(--cf-text)]">{display.provider}</p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
          <p className="text-sm text-[var(--cf-text-muted)]">Credit Score</p>
          <p className={`text-xl font-bold ${scoreColor}`}>{display.score ?? "N/A"}</p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
          <p className="text-sm text-[var(--cf-text-muted)]">Risk Grade</p>
          <p className="text-xl font-bold text-[var(--cf-text)]">{display.riskGrade ?? "N/A"}</p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
          <p className="text-sm text-[var(--cf-text-muted)]">Adverse Records</p>
          <p className={`text-xl font-bold ${display.adverseInfo.length > 0 ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}`}>{display.adverseInfo.length}</p>
        </div>
      </div>

      {display.unscoreable && (
        <div className="rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-4 text-sm text-[var(--cf-warning)]">
          The bureau reported this consumer as unscoreable.
        </div>
      )}

      {bureauDebt != null && (
        <div className={`rounded-lg border p-4 ${bureauDebt > selfDeclaredDebt ? "border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)]" : "border-[rgba(63,191,127,0.28)] bg-[rgba(63,191,127,0.08)]"}`}>
          <p className={`mb-2 text-sm font-semibold ${bureauDebt > selfDeclaredDebt ? "text-[var(--cf-warning)]" : "text-[var(--cf-success)]"}`}>
            Bureau Obligations vs Self-Declared
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-[var(--cf-text-muted)]">Self-declared monthly debt</p>
              <p className="whitespace-nowrap font-bold text-[var(--cf-text)]">{formatZAR(selfDeclaredDebt)}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--cf-text-muted)]">Bureau monthly obligations</p>
              <p className={`whitespace-nowrap font-bold ${bureauDebt > selfDeclaredDebt ? "text-[var(--cf-warning)]" : "text-[var(--cf-success)]"}`}>{formatZAR(bureauDebt)}</p>
            </div>
          </div>
          {bureauDebt > selfDeclaredDebt && (
            <p className="mt-2 text-xs text-amber-700">
              ⚠ Bureau shows {formatZAR(bureauDebt - selfDeclaredDebt)}/month more than declared — NDI uses bureau figure.
            </p>
          )}
        </div>
      )}

      {display.adverseInfo.length > 0 && (
        <div className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4">
          <p className="mb-2 text-sm font-semibold text-[var(--cf-danger)]">Adverse Information</p>
          <ul className="space-y-1">
            {display.adverseInfo.map((item) => (
              <li key={item} className="text-sm text-[var(--cf-text-secondary)]">&bull; {item}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-[var(--cf-text-muted)]">Check run: {formatDateTime(display.checkedAt)}</p>
    </div>
  )
}

function BureauOverrideNotice({ override }: { override: BureauOverrideDisplay }) {
  return (
    <div className="space-y-2 rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-4 text-sm">
      <div className="flex items-center gap-3 text-[var(--cf-warning)]">
        <AlertTriangle className="h-5 w-5 shrink-0" />
        <p className="font-semibold">Approval used an audited bureau-policy override.</p>
      </div>
      <p className="text-[var(--cf-text-secondary)]"><span className="font-semibold">Reason:</span> {override.reason}</p>
      <p className="text-xs text-[var(--cf-text-muted)]">Recorded {formatDateTime(override.recordedAt)} by staff ID {override.byId}</p>
    </div>
  )
}
