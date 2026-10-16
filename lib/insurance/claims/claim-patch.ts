/**
 * What PATCH /api/insurance/claims/[id] accepts. A claim's outcome is never a
 * plain field write: APPROVED only through "approve" (an amount within the
 * claim and the cover), REJECTED only through "reject" (a reason), PAID only
 * through "mark_paid" from APPROVED. The generic update may move a claim
 * between the two open statuses and edit its details, nothing more.
 */
export const CLAIM_ACTIONS = ["approve", "reject", "mark_paid"] as const
export type ClaimAction = (typeof CLAIM_ACTIONS)[number]

/** Statuses an insurer decision may still be recorded from. */
export const OPEN_CLAIM_STATUSES = ["SUBMITTED", "UNDER_REVIEW"] as const

export type ClaimPatchBody = {
  action?: unknown
  assessorId?: unknown
  insurerRef?: unknown
  approvedAmount?: unknown
  rejectionReason?: unknown
  status?: unknown
  notes?: unknown
  claimType?: unknown
  incidentDate?: unknown
  fnolDate?: unknown
}

export type GenericClaimUpdate = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

const optionalText = (value: unknown) => value === undefined || value === null || typeof value === "string"

function dateField(field: string, value: unknown): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null || value === "") return { ok: true, value: null }
  const date = typeof value === "string" ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return { ok: false, error: `${field} must be a date (YYYY-MM-DD)` }
  return { ok: true, value: date }
}

/** The generic update's fields, validated; a decision status is refused with the action to use. */
export function parseGenericClaimUpdate(body: ClaimPatchBody): GenericClaimUpdate {
  if (body.status !== undefined && !(OPEN_CLAIM_STATUSES as readonly unknown[]).includes(body.status)) {
    return {
      ok: false,
      error: `status may only be ${OPEN_CLAIM_STATUSES.join(" or ")}; record a decision with action "approve" or "reject", and a payment with "mark_paid"`,
    }
  }
  for (const field of ["notes", "claimType", "insurerRef", "rejectionReason"] as const) {
    if (!optionalText(body[field])) return { ok: false, error: `${field} must be text` }
  }
  const data: Record<string, unknown> = {}
  if (body.status !== undefined) data.status = body.status
  for (const field of ["notes", "claimType", "insurerRef", "rejectionReason"] as const) {
    if (body[field] !== undefined) data[field] = body[field]
  }
  for (const field of ["incidentDate", "fnolDate"] as const) {
    const parsed = dateField(field, body[field])
    if (!parsed.ok) return parsed
    if (parsed.value !== undefined) data[field] = parsed.value
  }
  return { ok: true, data }
}
