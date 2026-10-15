import { describe, expect, it } from "vitest"
import { formatDate, formatDateTime, SAST_TIME_ZONE } from "@/lib/utils"
import { formatDay, formatDayMonth, formatDayTime, formatLongDay } from "./format"

const TAGS = { af: "af-ZA", zu: "zu-ZA", xh: "xh-ZA" } as const
// Every month, at an instant whose UTC and SAST calendar days differ.
const DATES = Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2026, m, 3, 23, 30)))

describe("formatDay / formatLongDay / formatDayMonth", () => {
  it("English is the existing helpers' output, unchanged", () => {
    const d = new Date("2026-10-14T10:00:00Z")
    expect(formatDay(d, "en")).toBe(formatDate(d))
    expect(formatDayTime(d, "en")).toBe(formatDateTime(d))
    expect(formatLongDay(d, "en")).toBe("14 October 2026")
  })

  // Node's full ICU is the reference: the fixed CLDR tables must say exactly
  // what Intl says here, so the server and a browser without zu/xh data agree.
  it.each(Object.entries(TAGS))("%s matches Node's ICU for every month, on the SAST day", (locale, tag) => {
    for (const d of DATES) {
      const intl = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, { timeZone: SAST_TIME_ZONE, ...o }).format(d)
      const l = locale as keyof typeof TAGS
      expect(formatDay(d, l)).toBe(intl({ day: "numeric", month: "short", year: "numeric" }))
      expect(formatLongDay(d, l)).toBe(intl({ day: "numeric", month: "long", year: "numeric" }))
      expect(formatDayMonth(d, l)).toBe(intl({ day: "numeric", month: "short" }))
    }
  })

  it("puts the SAST time after the localised day", () => {
    expect(formatDayTime(new Date("2026-10-14T06:05:00Z"), "zu")).toBe("Okt 14, 2026 08:05")
  })
})
