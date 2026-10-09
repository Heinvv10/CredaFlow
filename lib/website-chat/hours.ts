// Pure and client-safe: no imports that reach @/lib/prisma.
type Window = { open: string; close: string }
type Days = Record<string, Window | null>

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
const DEFAULT_TZ = "Africa/Johannesburg"
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const WEEKDAY = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" } as Record<string, string>

const DEFAULT_DAYS: Days = Object.fromEntries(
  DAY_KEYS.map((d) => [d, d === "sat" || d === "sun" ? null : { open: "08:00", close: "17:00" }]),
)

function parseWindow(v: unknown): Window | null | undefined {
  if (v === null) return null
  if (typeof v !== "object" || Array.isArray(v)) return undefined
  const { open, close } = v as Record<string, unknown>
  if (typeof open !== "string" || typeof close !== "string") return undefined
  if (!HHMM.test(open) || !HHMM.test(close) || open >= close) return undefined
  return { open, close }
}

// Absent day = closed. A bad day = closed. No valid day at all in a non-empty
// `days` (or a non-object value) = malformed, so use the default hours.
function parseSettings(v: unknown): { tz: string; days: Days } {
  if (typeof v !== "object" || v === null) return { tz: DEFAULT_TZ, days: DEFAULT_DAYS }
  const { tz, days } = v as { tz?: unknown; days?: unknown }
  if (typeof days !== "object" || days === null || Array.isArray(days)) {
    return { tz: DEFAULT_TZ, days: DEFAULT_DAYS }
  }
  const parsed: Days = {}
  let valid = 0
  for (const d of DAY_KEYS) {
    if (!(d in days)) continue
    const w = parseWindow((days as Record<string, unknown>)[d])
    if (w !== undefined) valid++
    parsed[d] = w ?? null
  }
  const hasKeys = DAY_KEYS.some((d) => d in days)
  if (hasKeys && valid === 0) return { tz: DEFAULT_TZ, days: DEFAULT_DAYS }
  return { tz: typeof tz === "string" && tz ? tz : DEFAULT_TZ, days: parsed }
}

function localParts(now: Date, timeZone: string): { day: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ""
  return { day: WEEKDAY[get("weekday")] ?? "", hhmm: `${get("hour")}:${get("minute")}` }
}

const DAY_NAMES: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
}

/**
 * The open hours as a visitor reads them, in the tenant's own local times (the ones
 * isBusinessOpen checks): "Monday to Friday, 08:00 to 17:00 and Saturday, 08:00 to 12:00".
 * Consecutive days with the same times share one group. Null when no day is open.
 */
export function formatBusinessHours(businessHours: unknown): string | null {
  const { days } = parseSettings(businessHours)
  const groups: { from: string; to: string; w: Window }[] = []
  let prev: Window | null = null
  for (const d of DAY_KEYS) {
    const w = days[d] ?? null
    const last = groups[groups.length - 1]
    if (w && prev && last && w.open === prev.open && w.close === prev.close) last.to = d
    else if (w) groups.push({ from: d, to: d, w })
    prev = w
  }
  if (!groups.length) return null
  return groups
    .map((g) => `${DAY_NAMES[g.from]}${g.to === g.from ? "" : ` to ${DAY_NAMES[g.to]}`}, ${g.w.open} to ${g.w.close}`)
    .join(" and ")
}

export function isBusinessOpen(businessHours: unknown, now: Date): boolean {
  const { tz, days } = parseSettings(businessHours)
  let local: { day: string; hhmm: string }
  try {
    local = localParts(now, tz)
  } catch (e) {
    if (!(e instanceof RangeError)) throw e
    local = localParts(now, DEFAULT_TZ) // unknown tz name
  }
  const w = days[local.day]
  return !!w && w.open <= local.hhmm && local.hhmm < w.close
}
