// Canonical lost-reason set. Shared between the dedicated PATCH /lost route
// (which requires one of these) and the generic PATCH /[id] route (which
// validates any lostReason passed alongside a status change).
export const VALID_LOST_REASONS = [
  "TOO_EXPENSIVE",
  "WENT_ELSEWHERE",
  "NOT_QUALIFIED",
  "NO_RESPONSE",
  "PRODUCT_MISMATCH",
] as const

export type LostReason = typeof VALID_LOST_REASONS[number]
