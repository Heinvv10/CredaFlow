import Link from "next/link"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatStatusLabel, loanStatusTone } from "@/lib/status-style"

export function LoanSummaryBadges({
  status,
  applicationId,
  agreementSigned,
}: {
  status: string
  applicationId: string
  agreementSigned: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {agreementSigned ? (
        <StatusPill tone="success">Agreement signed</StatusPill>
      ) : (
        <StatusPill tone="warning">Agreement not signed</StatusPill>
      )}
      <StatusPill tone={loanStatusTone[status] ?? "neutral"}>
        {formatStatusLabel(status)}
      </StatusPill>
      <Link href={`/applications/${applicationId}`} className="text-xs font-medium text-[var(--cf-text-muted)] hover:text-[var(--cf-brand)] hover:underline">
        View application →
      </Link>
    </div>
  )
}
