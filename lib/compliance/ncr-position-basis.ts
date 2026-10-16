import type { NcrReturnData } from "./ncr-return"

type Fmt = (d: Date) => string

/** Where the return's POSITION lines come from, in one sentence, for the page, the CSV and the export. */
export function ncrPositionBasis(data: Pick<NcrReturnData, "positionSource" | "positionAsOf" | "positionIsStale">, asFiled: boolean, fmt: Fmt): string {
  if (asFiled) return "Position lines are the figures frozen at submission"
  if (data.positionSource === "SNAPSHOT" && data.positionAsOf) {
    return `Position lines are the book as at ${fmt(data.positionAsOf)}, from the daily arrears history`
  }
  return data.positionIsStale
    ? "Position lines reflect the book today, NOT the quarter end"
    : "Position lines reflect the book at generation"
}

/**
 * Where the daily arrears history starts. It is never backfilled: the loan
 * records hold only today's position, so the past cannot be rebuilt.
 */
export function ncrHistoryNote(historyStartsOn: Date | null, fmt: Fmt): string {
  return historyStartsOn
    ? `Daily arrears history starts on ${fmt(historyStartsOn)}; quarters that ended before then can only show today's book.`
    : "Daily arrears history has not started yet: it begins with the first nightly snapshot and is not backfilled."
}
