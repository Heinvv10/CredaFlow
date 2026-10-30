import { describe, expect, it } from "vitest"
import { addBusinessDays, isBusinessDate, lesothoPublicHolidays } from "./business-days"
import { addSouthAfricanBusinessDays, isSouthAfricanBusinessDate } from "@/lib/compliance/sa-business-days"

describe("Lesotho public holidays", () => {
  it("2026 fixed and Easter-based dates", () => {
    const h = lesothoPublicHolidays(2026)
    for (const d of ["2026-01-01", "2026-03-11", "2026-05-01", "2026-05-25", "2026-07-17", "2026-10-04", "2026-12-25", "2026-12-26"]) {
      expect(h.has(d), d).toBe(true)
    }
    // Easter Sunday 2026 is 5 April.
    expect(h.has("2026-04-03")).toBe(true) // Good Friday
    expect(h.has("2026-04-06")).toBe(true) // Easter Monday
    expect(h.has("2026-05-14")).toBe(true) // Ascension Day, Easter + 39
  })

  it("does not carry South African only days", () => {
    const h = lesothoPublicHolidays(2026)
    for (const d of ["2026-03-21", "2026-04-27", "2026-06-16", "2026-08-09", "2026-09-24", "2026-12-16"]) {
      expect(h.has(d), d).toBe(false)
    }
  })
})

describe("business days by jurisdiction", () => {
  it("LS treats Moshoeshoe's Day as closed and Youth Day as open", () => {
    expect(isBusinessDate("2026-03-11", "LS")).toBe(false) // Wednesday
    expect(isBusinessDate("2026-06-16", "LS")).toBe(true) // Tuesday, SA Youth Day
    expect(isBusinessDate("2026-06-16", "ZA")).toBe(false)
    expect(isBusinessDate("2026-03-11", "ZA")).toBe(true)
  })

  it("weekends are closed in both", () => {
    expect(isBusinessDate("2026-10-31", "LS")).toBe(false)
    expect(isBusinessDate("2026-11-01", "LS")).toBe(false)
  })

  it("ZA answers exactly as the South African calendar does", () => {
    for (let day = 1; day <= 365; day++) {
      const iso = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10)
      expect(isBusinessDate(iso, "ZA")).toBe(isSouthAfricanBusinessDate(iso))
    }
    expect(addBusinessDays("2026-12-14", 5, "ZA")).toBe(addSouthAfricanBusinessDays("2026-12-14", 5))
  })

  it("LS adds business days across its own holidays", () => {
    // Fri 2026-10-02 + 1 business day: Sat, Sun, Mon 5 Oct (Independence Day observed), then Tue 6 Oct.
    expect(addBusinessDays("2026-10-02", 1, "LS")).toBe("2026-10-06")
    // Tue 2026-03-10 + 1: Wed 11 Mar is Moshoeshoe's Day, so Thu 12 Mar.
    expect(addBusinessDays("2026-03-10", 1, "LS")).toBe("2026-03-12")
  })

  it("defaults to the active jurisdiction", () => {
    expect(isBusinessDate("2026-06-16")).toBe(false)
  })

  it("refuses a negative or fractional count and a malformed date", () => {
    expect(() => addBusinessDays("2026-03-10", -1, "LS")).toThrow(RangeError)
    expect(() => addBusinessDays("2026-03-10", 1.5, "LS")).toThrow(RangeError)
    expect(() => isBusinessDate("2026-3-1", "LS")).toThrow(RangeError)
  })
})

describe("Heroes' Day (4 April)", () => {
  it("is a holiday on a weekday: 4 Apr 2028 is a Tuesday", () => {
    expect(lesothoPublicHolidays(2028).has("2028-04-04")).toBe(true)
    expect(isBusinessDate("2028-04-04", "LS")).toBe(false)
    expect(isBusinessDate("2028-04-04", "ZA")).toBe(true)
    expect(addBusinessDays("2028-04-03", 1, "LS")).toBe("2028-04-05")
  })
})

describe("Sunday holidays and malformed input", () => {
  it("LS observes a Sunday holiday on the Monday (4 Oct 2026 is a Sunday)", () => {
    expect(lesothoPublicHolidays(2026).has("2026-10-05")).toBe(true)
    expect(isBusinessDate("2026-10-05", "LS")).toBe(false)
    expect(addBusinessDays("2026-10-02", 1, "LS")).toBe("2026-10-06")
  })

  it.each(["", "2026-3-1", "20260301", "2026-13-01", "2026-02-30", "not a date", "2026-03-01T00:00:00Z"])(
    "LS and ZA treat %j alike",
    (input) => {
      const outcome = (jurisdiction: "LS" | "ZA") => {
        try { return String(isBusinessDate(input, jurisdiction)) } catch (e) { return `${(e as Error).name}` }
      }
      expect(outcome("LS")).toBe(outcome("ZA"))
      const add = (jurisdiction: "LS" | "ZA") => {
        try { return addBusinessDays(input, 1, jurisdiction) } catch (e) { return `${(e as Error).name}` }
      }
      expect(add("LS")).toBe(add("ZA"))
    },
  )
})
