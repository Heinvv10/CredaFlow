/**
 * Pure helpers for the compliance dashboard server component.
 *
 * These live here rather than in `app/(dashboard)/compliance/page.tsx` because
 * Next.js restricts which symbols a page file may export, so anything defined
 * there is unreachable from a test. Both functions below are load-bearing and
 * were previously untestable for exactly that reason: one validates a
 * user-controlled query parameter, the other is the POPIA redaction that keeps
 * Section 129 snapshots out of the client bundle.
 */

import type { ComplianceType, Prisma } from "@prisma/client"
import { isSection129PendingIssuanceStale } from "@/lib/collections/section129-artifact"
import {
  COMPLIANCE_TYPE_GROUP,
  isKnownType,
  type ComplianceGroup,
} from "@/lib/compliance/record-types"

export const COMPLIANCE_GROUPS: ComplianceGroup[] = ["OBLIGATION", "EXCEPTION", "REGISTER", "LEGACY"]

export function parseGroup(raw: string | undefined): ComplianceGroup | null {
  return COMPLIANCE_GROUPS.includes(raw as ComplianceGroup) ? (raw as ComplianceGroup) : null
}

/**
 * Coerce the user-controlled `?type=` param to a real ComplianceType.
 *
 * Uses `Object.hasOwn` via `isKnownType`, never `in` or a bare index: both walk
 * the prototype chain, so `?type=constructor` would pass validation and reach
 * Prisma as an invalid enum value, 500-ing a compliance page.
 */
export function parseType(raw: string | undefined): ComplianceType | null {
  return raw && isKnownType(raw) ? raw : null
}

export function typesInGroup(group: ComplianceGroup): ComplianceType[] {
  return (Object.keys(COMPLIANCE_TYPE_GROUP) as ComplianceType[])
    .filter((t) => COMPLIANCE_TYPE_GROUP[t] === group)
}

/** The shape the client component receives. Deliberately narrow. */
export type DashboardClientRecord = {
  id: string
  type: string
  status: string
  referenceId: string | null
  dueDate: Date | null
  completedAt: Date | null
  createdAt: Date
  data: { lifecycle?: string }
  section129RecoveryAvailable: boolean
}

type ComplianceRow = {
  id: string
  type: string
  status: string
  referenceId: string | null
  dueDate: Date | null
  completedAt: Date | null
  createdAt: Date
  data: Prisma.JsonValue | null
}

/**
 * Project a ComplianceRecord for the client bundle.
 *
 * The client must NEVER receive the full `data` payload. A Section 129 snapshot
 * holds the consumer's name, ID number, address, email, arrears balance,
 * outstanding principal and an absolute private-storage path for the rendered
 * notice. Only `lifecycle` drives the dashboard's action column, so only
 * `lifecycle` crosses. Everything else is dropped by construction — this builds
 * a new object rather than spreading and deleting, so a field added to the
 * model later cannot leak by default.
 */
export function toDashboardClientRecord(
  record: ComplianceRow,
  now: Date,
): DashboardClientRecord {
  const lifecycle = record.data
    && typeof record.data === "object"
    && !Array.isArray(record.data)
    && typeof (record.data as { lifecycle?: unknown }).lifecycle === "string"
    ? (record.data as { lifecycle: string }).lifecycle
    : undefined

  return {
    id: record.id,
    type: record.type,
    status: record.status,
    referenceId: record.referenceId,
    dueDate: record.dueDate,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    data: lifecycle ? { lifecycle } : {},
    section129RecoveryAvailable: record.type === "SECTION_129_NOTICE"
      && record.status === "PENDING"
      && isSection129PendingIssuanceStale(record.data, now),
  }
}
