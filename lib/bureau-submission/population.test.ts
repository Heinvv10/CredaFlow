import { describe, expect, it } from "vitest"
import { bureauAccountNumber, cleanAddressLine, cleanName, cleanPhone, cleanPostalCode, forenames, isValidAccountNumber, wholeRands } from "./clean"
import { dayAsOf, dayEnd, dayOf, dayStart, isDay, isMonthEnd, monthStartOf, previousDay, previousMonthEnd } from "./period"
import { NO_HISTORY, monthlyDisposition, type LedgerHistory } from "./population"

const history = (over: Partial<LedgerHistory>): LedgerHistory => ({ ...NO_HISTORY, known: true, ...over })

describe("monthlyDisposition — what was already sent decides what goes", () => {
  it("includes an open loan the bureau has never seen", () => {
    expect(monthlyDisposition("ACTIVE", NO_HISTORY)).toEqual({ action: "INCLUDE" })
    expect(monthlyDisposition("DEFAULTED", NO_HISTORY)).toEqual({ action: "INCLUDE" })
  })

  it("includes a closed loan until its closure has been in a monthly file, then drops it", () => {
    expect(monthlyDisposition("COMPLETED", NO_HISTORY)).toEqual({ action: "INCLUDE" })
    // A daily closure does not count: the monthly file repeats it once.
    expect(monthlyDisposition("COMPLETED", history({ dailySent: ["T"] }))).toEqual({ action: "INCLUDE" })
    expect(monthlyDisposition("COMPLETED", history({ monthlySent: ["T"] }))).toEqual({ action: "DROP" })
    expect(monthlyDisposition("COMPLETED", history({ monthlySent: ["C"] }))).toEqual({ action: "DROP" })
  })

  it("holds a loan that is open again after its closure was sent, in either file", () => {
    const held = { action: "HOLD", reason: "REOPENED_AFTER_CLOSURE" }
    expect(monthlyDisposition("ACTIVE", history({ monthlySent: ["C"] }))).toEqual(held)
    expect(monthlyDisposition("ACTIVE", history({ dailySent: ["T"] }))).toEqual(held)
    expect(monthlyDisposition("DEFAULTED", history({ monthlySent: ["T"] }))).toEqual(held)
  })

  it("drops a loan whose write-off or death was sent, whatever its status now", () => {
    for (const status of ["ACTIVE", "WRITTEN_OFF", "COMPLETED", "CANCELLED"]) {
      expect(monthlyDisposition(status, history({ monthlySent: ["W"] })), status).toEqual({ action: "DROP" })
      expect(monthlyDisposition(status, history({ monthlySent: ["Z"] })), status).toEqual({ action: "DROP" })
    }
  })

  it("keeps reporting a handed-over loan after L was sent", () => {
    expect(monthlyDisposition("ACTIVE", history({ monthlySent: ["L"] }))).toEqual({ action: "INCLUDE" })
  })

  it("includes a written-off loan until its under-R100 closure was sent", () => {
    expect(monthlyDisposition("WRITTEN_OFF", NO_HISTORY)).toEqual({ action: "INCLUDE" })
    expect(monthlyDisposition("WRITTEN_OFF", history({ monthlySent: ["C"] }))).toEqual({ action: "DROP" })
  })

  it("never reports a cancelled loan the bureau has not seen, and holds one it has", () => {
    expect(monthlyDisposition("CANCELLED", NO_HISTORY)).toEqual({ action: "DROP" })
    expect(monthlyDisposition("CANCELLED", history({}))).toEqual({ action: "HOLD", reason: "CANCELLED_AFTER_REGISTRATION" })
  })
})

describe("period — SAST calendar days on a UTC clock", () => {
  it("bounds a day at SAST midnight, two hours before UTC midnight", () => {
    expect(dayStart("2026-09-30").toISOString()).toBe("2026-09-29T22:00:00.000Z")
    expect(dayEnd("2026-09-30").toISOString()).toBe("2026-09-30T22:00:00.000Z")
    expect(dayAsOf("2026-09-30").toISOString()).toBe("2026-09-30T10:00:00.000Z")
  })

  it("places an instant in the 00:00-02:00 SAST band on the SAST day, not the UTC one", () => {
    expect(dayOf(new Date("2026-09-30T22:30:00.000Z"))).toBe("2026-10-01")
    expect(dayOf(new Date("2026-09-30T21:59:59.000Z"))).toBe("2026-09-30")
  })

  it("names the month end and the day just ended from a run early on the 1st", () => {
    const run = new Date("2026-09-30T22:20:00.000Z") // 1 Oct 00:20 SAST, still 30 Sep in UTC
    expect(previousMonthEnd(run)).toBe("2026-09-30")
    expect(previousDay(run)).toBe("2026-09-30")
    expect(previousMonthEnd(new Date("2026-03-15T10:00:00.000Z"))).toBe("2026-02-28")
    expect(previousMonthEnd(new Date("2028-03-01T10:00:00.000Z"))).toBe("2028-02-29")
    expect(previousDay(new Date("2026-01-01T10:00:00.000Z"))).toBe("2025-12-31")
  })

  it("recognises month ends and real calendar days only", () => {
    expect(isMonthEnd("2026-09-30")).toBe(true)
    expect(isMonthEnd("2026-09-29")).toBe(false)
    expect(isMonthEnd("2026-02-28")).toBe(true)
    expect(isMonthEnd("2028-02-28")).toBe(false)
    expect(monthStartOf("2026-09-30")).toBe("2026-09-01")
    expect(isDay("2026-09-30")).toBe(true)
    for (const bad of ["2026-02-30", "20260930", "30/09/2026", "", null, undefined]) expect(isDay(bad), String(bad)).toBe(false)
  })
})

describe("clean", () => {
  it("keeps only the characters a name may carry, folding accents", () => {
    expect(cleanName("  van der  Merwe ")).toBe("VAN DER MERWE")
    expect(cleanName("O'Brien-Smith")).toBe("O'BRIEN-SMITH")
    expect(cleanName("Zoë\r\nD8810145000083")).toBe("ZOE D")
    expect(forenames("Sue Ann Mary Jane")).toEqual(["SUE", "ANN", "MARY"])
  })

  it("strips control characters and punctuation from an address line", () => {
    expect(cleanAddressLine("12 Main Rd,\r\nUnit #4")).toBe("12 MAIN RD UNIT 4")
    expect(cleanAddressLine("same as above")).toBe("")
    expect(cleanAddressLine("Nala Street")).toBe("NALA STREET")
  })

  it("accepts only a real postal code and a ten-digit phone number", () => {
    expect(cleanPostalCode("0122")).toBe("0122")
    expect(cleanPostalCode("1234567")).toBe("")
    expect(cleanPostalCode("n/a")).toBe("")
    expect(cleanPhone("+27 82 123 4567")).toBe("0821234567")
    expect(cleanPhone("082 123 4567")).toBe("0821234567")
    expect(cleanPhone("0000000000")).toBe("")
    expect(cleanPhone("082123")).toBe("")
  })

  describe("bureauAccountNumber", () => {
    const applicationId = "clxtest000000000000000001" // a 25-character id, as a mandated loan carries
    it("upper-cases a reference that fits and changes nothing else", () => {
      expect(bureauAccountNumber("LN-TEST0A-0001")).toBe("LN-TEST0A-0001")
      expect(bureauAccountNumber("ln-test0a-0001")).toBe("LN-TEST0A-0001")
      expect(bureauAccountNumber("LN-OUTAGE-APP-TEST0A-000")).toBe("LN-OUTAGE-APP-TEST0A-000")
      // Exactly 25 characters still fits: the prefix stays.
      expect(bureauAccountNumber(`LN-${"A".repeat(22)}`)).toBe(`LN-${"A".repeat(22)}`)
    })
    it("drops the LN- prefix of a reference over 25 characters, leaving the 25-character id", () => {
      const account = bureauAccountNumber(`LN-${applicationId}`)
      expect(account).toBe("CLXTEST000000000000000001")
      expect(account).toHaveLength(25)
      expect(isValidAccountNumber(account)).toBe(true)
    })
    it("leaves a reference it cannot make fit as it is, to be held", () => {
      const noPrefix = "X".repeat(26)
      expect(bureauAccountNumber(noPrefix)).toBe(noPrefix)
      const stillTooLong = `LN-${"A".repeat(26)}`
      expect(isValidAccountNumber(bureauAccountNumber(stillTooLong))).toBe(false)
    })
    it("shortens only the exact mandated shape, so no two references can share an account number", () => {
      // 26 characters with the prefix: not the mandated shape, so not shortened, so held.
      const short = `LN-${"A".repeat(23)}`
      expect(bureauAccountNumber(short)).toBe(short)
      expect(isValidAccountNumber(bureauAccountNumber(short))).toBe(false)
      // A doubled prefix would otherwise land on another loan's 25-character reference.
      const doubled = `LN-LN-${"A".repeat(22)}`
      expect(bureauAccountNumber(doubled)).toBe(doubled)
      // A separator inside the id is not the mandated shape either.
      const dashed = `LN-${"A".repeat(12)}-${"A".repeat(12)}`
      expect(bureauAccountNumber(dashed)).toBe(dashed)
    })
    it("passes a non-ASCII reference through untouched, to be held", () => {
      const sharp = `LN-${"A".repeat(21)}ß` // upper-casing would make this LN-…SS, 26 characters
      expect(bureauAccountNumber(sharp)).toBe(sharp)
      expect(isValidAccountNumber(bureauAccountNumber(sharp))).toBe(false)
    })
    it("is stable: the same reference always gives the same account number", () => {
      expect(bureauAccountNumber(`ln-${applicationId}`)).toBe(bureauAccountNumber(`LN-${applicationId.toUpperCase()}`))
    })
  })

  it("validates an account number and rounds cents to whole rands", () => {
    expect(isValidAccountNumber("LN-AB/1\\2")).toBe(true)
    expect(isValidAccountNumber("ln-1")).toBe(false)
    expect(isValidAccountNumber("")).toBe(false)
    expect(wholeRands(149)).toBe(1)
    expect(wholeRands(150)).toBe(2)
    expect(wholeRands(-500)).toBe(0)
  })
})
