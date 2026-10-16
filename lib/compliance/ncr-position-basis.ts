import type { NcrReturnData } from "./ncr-return"

type Fmt = (d: Date) => string

/** Where the return's POSITION lines come from, in one sentence, for the page, the CSV and the export. */
export function ncrPositionBasis(data: Pick<NcrReturnData, "positionSource" | "positionAsOf" | "positionIsStale">, asFiled: boolean, fmt: Fmt): string {
  if (asFiled) return "Position lines are the figures frozen at submission"
  if (data.positionSource === "SNAPSHOT" && data.positionAsOf) {
    return `Position at quarter end: the book as at ${fmt(data.positionAsOf)}, from the daily arrears history`
  }
  return data.positionIsStale
    ? "Position lines reflect the book today, NOT the quarter end"
    : "Position lines reflect the book at generation"
}

/**
 * Why a closed quarter has no history to read, for the stale warning. History
 * is never backfilled: the loan records hold only today's position.
 */
export function ncrHistoryNote(historyStartsOn: Date | null, periodEnd: Date, fmt: Fmt): string {
  if (!historyStartsOn) {
    return "Daily arrears history has not started yet: it begins with the first nightly snapshot and is not backfilled."
  }
  // historyStartsOn is a calendar day (UTC midnight of the SAST date); periodEnd
  // the quarter's last instant, on its last SAST day.
  return historyStartsOn.getTime() > periodEnd.getTime()
    ? `Daily arrears history starts on ${fmt(historyStartsOn)}, after this quarter ended; it is not backfilled.`
    : `No arrears snapshot was recorded on the quarter's last day (${fmt(periodEnd)}), although history starts on ${fmt(historyStartsOn)}.`
}
