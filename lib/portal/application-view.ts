import type { AppStatus } from "@prisma/client"
import { decisionKind } from "@/lib/applications/decision-kind"

/** The status a borrower sees: a disbursed application whose loan is paid up reads Settled. */
export type PortalApplicationStatus = AppStatus | "SETTLED"

export function portalApplicationStatus(status: AppStatus, loanStatus: string | null | undefined): PortalApplicationStatus {
  return status === "DISBURSED" && loanStatus === "COMPLETED" ? "SETTLED" : status
}

export type TimelineLabel =
  | "tlSubmitted" | "tlIncomeVerified" | "tlUnderReview" | "tlPasqGenerated" | "tlPasqAcknowledged"
  | "tlApproved" | "tlDeclined" | "tlAgreementGenerated" | "tlAgreementSigned" | "tlMandatePrepared"
  | "tlMandateSigned" | "tlDisbursed"

export interface TimelineEvent {
  label: TimelineLabel
  date: Date
}

export interface TimelineApplication {
  status: AppStatus
  createdAt: Date
  updatedAt: Date
  submittedAt: Date | null
  incomeVerifiedAt: Date | null
  pasqGeneratedAt: Date | null
  pasqAcknowledgedAt: Date | null
  pasqAcknowledgedSha256: string | null
  pasqDocumentSha256: string | null
  approvedAt: Date | null
  declineCategory: string | null
  agreementGeneratedAt: Date | null
  agreementSignedAt: Date | null
  debitMandatePreparedAt: Date | null
  debitMandateSignedAt: Date | null
  disbursedAt: Date | null
}

/** The application's history, oldest first. */
export function buildApplicationTimeline(app: TimelineApplication): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { label: "tlSubmitted", date: app.submittedAt ?? app.createdAt },
  ]

  if (app.incomeVerifiedAt) {
    events.push({ label: "tlIncomeVerified", date: app.incomeVerifiedAt })
  } else if (["UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED"].includes(app.status)) {
    // No review-start stamp exists. updatedAt moves with every later write, so
    // after a decision it is no earlier than the decision itself and the review
    // sorted after "declined" (Fair Score audit 2026-10-16). Review happened
    // before the decision: cap it there (the sort is stable, so on a tie it
    // keeps its place ahead of the decision).
    const reviewed = app.approvedAt && app.approvedAt < app.updatedAt ? app.approvedAt : app.updatedAt
    events.push({ label: "tlUnderReview", date: reviewed })
  }

  if (app.pasqGeneratedAt) events.push({ label: "tlPasqGenerated", date: app.pasqGeneratedAt })
  if (app.pasqAcknowledgedAt && app.pasqAcknowledgedSha256 === app.pasqDocumentSha256) {
    events.push({ label: "tlPasqAcknowledged", date: app.pasqAcknowledgedAt })
  }

  const kind = decisionKind(app)
  if (app.approvedAt && kind) {
    events.push({ label: kind === "declined" ? "tlDeclined" : "tlApproved", date: app.approvedAt })
  }

  if (app.agreementGeneratedAt) events.push({ label: "tlAgreementGenerated", date: app.agreementGeneratedAt })
  if (app.agreementSignedAt) events.push({ label: "tlAgreementSigned", date: app.agreementSignedAt })
  if (app.debitMandatePreparedAt) events.push({ label: "tlMandatePrepared", date: app.debitMandatePreparedAt })
  if (app.debitMandateSignedAt) events.push({ label: "tlMandateSigned", date: app.debitMandateSignedAt })
  if (app.disbursedAt) events.push({ label: "tlDisbursed", date: app.disbursedAt })

  return events.sort((a, b) => a.date.getTime() - b.date.getTime())
}
