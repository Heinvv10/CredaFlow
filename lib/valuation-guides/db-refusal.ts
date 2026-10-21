/**
 * The database refusals the store answers itself (a 409, not a 500). Each is
 * matched on the guard's exact sentence, or the CHECK's name; migration.test.ts
 * pins each one to the latest definition of the guard that raises it, so a
 * reworded guard fails that test rather than turning a 409 into a 500.
 */

/** guardAssetValuationGuide: SAST midnight passed between reading a row and writing its valuation. */
export const GUIDE_DAY_REFUSAL = "A guide valuation is dated the day it is read"
/** guardValuationGuide: SAST midnight passed between the store's effective-date check and the publish. */
export const GUIDE_EFFECTIVE_REFUSAL = "A guide is published on or after its effective date"
/** ValuationGuide_times: a residual clock race between two publishes of one name. */
export const GUIDE_TIMES_CHECK = "ValuationGuide_times"

/** Whether `error` is the database's refusal with this exact sentence or constraint name (SQLSTATE 23514). */
export function isDbRefusal(error: unknown, marker: string): boolean {
  return error instanceof Error && error.message.includes(marker)
}
