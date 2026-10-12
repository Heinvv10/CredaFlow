/**
 * The breach log's statuses and the moves between them. Shared by the API,
 * which enforces them, and BreachLogClient, which offers exactly these, so the
 * register cannot be moved in a way its screen never shows. Client-safe.
 */
export const BREACH_LOG_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  OPEN: ["CONTAINED", "RESOLVED"],
  CONTAINED: ["RESOLVED"],
  RESOLVED: [],
}

export function isBreachLogStatus(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(BREACH_LOG_TRANSITIONS, value)
}

export function canMoveBreachLog(from: string, to: string): boolean {
  return BREACH_LOG_TRANSITIONS[from]?.includes(to) ?? false
}

/** A date string that parses, or null. */
export function parseBreachLogDate(value: unknown): Date | null {
  if (typeof value !== "string") return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
