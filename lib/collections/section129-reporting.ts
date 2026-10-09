import type { Prisma } from "@prisma/client"

type Section129ReportRecord = {
  id: string
  referenceId: string | null
  status: string
  completedAt: Date | null
  createdAt: Date
  data: Prisma.JsonValue | null
}

type Snapshot = Record<string, unknown>

/**
 * SAST-midnight quarter boundaries. Re-exported from the shared quarter module
 * so the Section 129 register, the NCR return and the FSCA return cannot drift
 * into disagreeing about which quarter an event falls in.
 */
export { sastQuarterBounds } from "@/lib/compliance/quarters"

function snapshot(data: Prisma.JsonValue | null): Snapshot | null {
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Snapshot
    : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function number(value: unknown): number | "" {
  return typeof value === "number" && Number.isFinite(value) ? value : ""
}

function money(value: unknown): number | "" {
  const cents = number(value)
  return cents === "" ? "" : cents / 100
}

function formattedSnapshotDate(
  value: unknown,
  formatDate: (value: Date) => string,
): string {
  if (typeof value !== "string") return ""
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? formatDate(parsed) : ""
}

function attemptOutcome(status: string, lifecycle: string): string {
  if (status === "COMPLETED" && lifecycle === "ISSUED") return "ISSUED"
  if (lifecycle === "RECONCILIATION_REQUIRED") return "DELIVERY_UNCERTAIN"
  if (lifecycle === "FAILED") return "KNOWN_NOT_SENT"
  if (["STAGING", "READY", "DISPATCHING"].includes(lifecycle)) return "IN_PROGRESS"
  return "LEGACY_UNCLASSIFIED"
}

export function section129SentInPeriodWhere(
  tenantId: string,
  start: Date,
  endExclusive: Date,
) {
  return {
    tenantId,
    type: "SECTION_129_NOTICE" as const,
    status: "COMPLETED" as const,
    completedAt: { gte: start, lt: endExclusive },
    data: { path: ["lifecycle"], equals: "ISSUED" },
  }
}

/**
 * Build the legal register from the immutable attempt snapshot. Never join to
 * the live Loan/Client rows: later payments or profile edits must not rewrite
 * what a statutory notice said when it was issued.
 */
export function section129LogRow(
  record: Section129ReportRecord,
  formatDate: (value: Date) => string,
): Record<string, string | number> {
  const data = snapshot(record.data)
  const lifecycle = text(data?.lifecycle)
  const redacted = Boolean(data?.snapshotRedactedAt)
  const clientName = text(data?.clientName)
    || [text(data?.clientFirstName), text(data?.clientLastName)].filter(Boolean).join(" ")
  const hasImmutableSnapshot = Boolean(
    data
    && !redacted
    && lifecycle
    && typeof data.loanReference === "string"
    && typeof data.clientEmail === "string"
    && typeof data.arrearsAmount === "number"
    && typeof data.outstandingPrincipal === "number"
    && typeof data.daysInArrears === "number",
  )

  return {
    "Notice Reference": record.id,
    "Loan Reference": text(data?.loanReference) || record.referenceId || "",
    "Client Full Name": redacted ? "" : clientName,
    "ID Number": redacted ? "" : text(data?.clientIdNumber),
    "Email": redacted ? "" : text(data?.clientEmail),
    "Address Line 1": redacted ? "" : text(data?.clientAddressLine1),
    "City": redacted ? "" : text(data?.clientCity),
    "Outstanding at Attempt (R)": redacted ? "" : money(data?.outstandingPrincipal),
    "Days in Arrears at Attempt": redacted ? "" : number(data?.daysInArrears),
    "Arrears Amount at Attempt (R)": redacted ? "" : money(data?.arrearsAmount),
    "Record Status": record.status,
    Lifecycle: lifecycle || "LEGACY_UNCLASSIFIED",
    "Attempt Outcome": attemptOutcome(record.status, lifecycle),
    "Snapshot Source": redacted
      ? "REDACTED_KNOWN_NOT_SENT"
      : hasImmutableSnapshot
        ? "IMMUTABLE_ISSUANCE_SNAPSHOT"
        : "LEGACY_RECORD_NO_SNAPSHOT",
    "PDF SHA-256": text(data?.pdfSha256),
    "Provider Evidence Reference": text(data?.emailMessageId),
    "Failure Reason": text(data?.failureReason),
    "Attempt Created At": formatDate(record.createdAt),
    "Issued At": formattedSnapshotDate(data?.issuedAt, formatDate),
    "Completed At": record.completedAt ? formatDate(record.completedAt) : "",
  }
}
