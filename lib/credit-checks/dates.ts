/** Calendar arithmetic on YYYY-MM-DD strings, in UTC so no time zone shifts a day. */

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** YYYY-MM of each calendar month the range touches. */
export function monthsCovered(start: string, end: string): string[] {
  const out: string[] = []
  let y = Number(start.slice(0, 4))
  let m = Number(start.slice(5, 7))
  const endKey = end.slice(0, 7)
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`
    if (key > endKey) return out
    out.push(key)
    m = m === 12 ? 1 : m + 1
    if (m === 1) y++
  }
}

/** The given day of a YYYY-MM month, clamped to the month's last day. */
export function dayInMonth(month: string, day: number): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`
}
