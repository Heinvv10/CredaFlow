import { describe, expect, it } from "vitest"
import { addMonthsClamped } from "@/lib/asset-finance/dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { agreementPayableOn, KEY_FACTS_BANK_REF_MAX, manualBankRef, payoutVerificationNote, PAYOUT_VERIFICATION_NOTE_MAX, PAYOUT_VERIFICATION_NOTE_MIN } from "./payout-terms"

describe("the bank reference of a manual transfer", () => {
  it("is required, trimmed, a single line and bounded", () => {
    expect(manualBankRef("  LS-1  ")).toBe("LS-1")
    expect(manualBankRef("x".repeat(KEY_FACTS_BANK_REF_MAX))).toHaveLength(KEY_FACTS_BANK_REF_MAX)
    for (const refused of [null, undefined, "", "   ", "x".repeat(KEY_FACTS_BANK_REF_MAX + 1), 1234, {}, "two\nlines"]) expect(manualBankRef(refused)).toBeNull()
  })
})

describe("the second person's note", () => {
  it("says how the account was confirmed, within bounds", () => {
    expect(payoutVerificationNote("x".repeat(PAYOUT_VERIFICATION_NOTE_MIN))).toHaveLength(PAYOUT_VERIFICATION_NOTE_MIN)
    for (const refused of [null, "x".repeat(PAYOUT_VERIFICATION_NOTE_MIN - 1), "x".repeat(PAYOUT_VERIFICATION_NOTE_MAX + 1), ` ${" ".repeat(30)} `]) expect(payoutVerificationNote(refused)).toBeNull()
  })
})

describe("the agreement's start date", () => {
  const start = new Date("2026-11-15T21:30:00.000Z") // 23:30 on the 15th, SAST
  it("is the one SAST day it can be paid out, whichever UTC day that spans", () => {
    expect(agreementPayableOn(start, new Date("2026-11-15T21:59:59.000Z"))).toBe(true)
    expect(agreementPayableOn(start, new Date("2026-11-15T22:00:00.000Z"))).toBe(false)
    expect(agreementPayableOn(new Date("2026-11-15T22:30:00.000Z"), new Date("2026-11-15T23:00:00.000Z"))).toBe(true)
  })
  it("refuses a later day and an earlier one, today whatever the day of the month", () => {
    const today = new Date()
    expect(agreementPayableOn(today, today)).toBe(true)
    expect(agreementPayableOn(today, new Date(today.getTime() + 86_400_000))).toBe(false)
    expect(agreementPayableOn(today, new Date(today.getTime() - 86_400_000))).toBe(false)
    expect(agreementPayableOn(today, new Date(`${addMonthsClamped(sastCalendarDate(today), 1)}T12:00:00+02:00`))).toBe(false)
  })
})
