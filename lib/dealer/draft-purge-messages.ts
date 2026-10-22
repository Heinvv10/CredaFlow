/** The database's refusals around erased (purged) people and businesses, for routes to name them. */
export const ERASED_PARTY = "An erased person or business is not used again"
export const ERASED_FROZEN = "An erased person or business is not changed"

/** Whether an error is the database refusing to change an erased row (freezeDealerPurgedParty). */
export function isErasedRowEdit(error: unknown): boolean {
  return error instanceof Error && error.message.includes(ERASED_FROZEN)
}
