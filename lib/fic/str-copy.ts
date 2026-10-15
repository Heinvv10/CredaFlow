/**
 * Client-safe STR constants (no Node imports): used by the raise dialog as
 * well as the server. Pinned to the DB CHECK SuspiciousReportCase_outcome_complete.
 */
export const GROUNDS_MIN_LENGTH = 20
export const GROUNDS_MAX_LENGTH = 5000
export const CLOSE_NOTE_MIN_LENGTH = 15

/** The goAML-ready draft export of a register (app/api/compliance/fic/export). */
export function ficExportHref(register: "ctr" | "str", format: "csv" | "xml"): string {
  return `/api/compliance/fic/export?register=${register}&format=${format}`
}

export const TIPPING_OFF_WARNING =
  "Do not tell the client, or anyone who does not need to know, that this report exists or may be made. " +
  "Tipping off is an offence under the FIC Act. Do not note it on the client's file, in messages or in loan notes."
