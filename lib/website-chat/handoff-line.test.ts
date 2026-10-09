import { describe, expect, it } from "vitest"
import { handoffLine, withHandoffLine } from "./handoff-line"

const SAT = { days: { mon: { open: "08:00", close: "17:00" }, tue: { open: "08:00", close: "17:00" }, sat: { open: "08:00", close: "12:00" } } }

describe("handoffLine", () => {
  it("agrees to a visitor who asked for a person while consultants are being waited for", () => {
    expect(handoffLine("asked_for_person", "waiting", true, null)).toBe("Sure, I'll connect you to one of our consultants.")
  })
  it.each(["account_question", "out_of_scope", "message_limit", "daily_limit", "assistant_unavailable", "empty_reply", null] as const)(
    "says the assistant can't help for %s while consultants are being waited for",
    (reason) => {
      expect(handoffLine(reason, "waiting", true, null)).toBe("I can't help with that here, so I'll connect you to a consultant.")
    },
  )
  it.each(["asked_for_person", "complaint", "daily_limit"] as const)("in the fallback after hours says nobody is available, with the configured hours, for %s", (reason) => {
    expect(handoffLine(reason, "fallback", false, null)).toBe("Our consultants aren't available right now. They're available Monday to Friday, 08:00 to 17:00.")
    expect(handoffLine(reason, "fallback", false, SAT)).toBe("Our consultants aren't available right now. They're available Monday to Tuesday, 08:00 to 17:00 and Saturday, 08:00 to 12:00.")
  })
  it.each(["asked_for_person", "complaint", "daily_limit"] as const)("in the fallback within business hours (an earlier wait timed out) says nobody can join, with no hours, for %s", (reason) => {
    expect(handoffLine(reason, "fallback", true, null)).toBe("Our consultants can't join the chat right now.")
    expect(handoffLine(reason, "fallback", true, SAT)).toBe("Our consultants can't join the chat right now.")
  })
  it("in the fallback with no open day names no hours", () => {
    expect(handoffLine("asked_for_person", "fallback", false, { days: { mon: null } })).toBe("Our consultants aren't available right now.")
  })
  it("never produces the old refusal-sounding sentence", () => {
    for (const mode of ["waiting", "fallback"] as const) {
      for (const inHours of [true, false]) expect(handoffLine("asked_for_person", mode, inHours, null)).not.toContain("passing this to")
    }
  })
})

describe("withHandoffLine", () => {
  it("keeps the model's text and puts the line after it, separated by a blank line", () => {
    expect(withHandoffLine("Please don't share ID numbers here.", "LINE")).toBe("Please don't share ID numbers here.\n\nLINE")
  })
  it("uses the line alone when the model wrote nothing", () => {
    expect(withHandoffLine("", "LINE")).toBe("LINE")
    expect(withHandoffLine("  \n ", "LINE")).toBe("LINE")
  })
})
