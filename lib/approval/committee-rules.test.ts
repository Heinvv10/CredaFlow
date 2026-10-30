import { describe, expect, it } from "vitest"
import { committeeProblems } from "./committee-rules"

const today = new Date("2026-11-05T10:00:00Z")
const ok = { decision: "APPROVED" as const, meetingDate: "2026-11-05", attendees: ["A. Dlamini", "B. Mokoena"], conditions: ["Obtain a signed employer letter before disbursement"], rationale: "Strong affordability and a clean bureau record" }

describe("committeeProblems", () => {
  it("accepts an approval with conditions, and a decline or deferral with none", () => {
    expect(committeeProblems(ok, today)).toEqual([])
    expect(committeeProblems({ ...ok, decision: "DECLINED", conditions: [] }, today)).toEqual([])
    expect(committeeProblems({ ...ok, decision: "DEFERRED", conditions: [] }, today)).toEqual([])
  })
  it.each([
    ["conditions on a decline", { decision: "DECLINED" as const }, /conditions/],
    ["no attendees", { attendees: [] }, /attend/],
    ["an attendee with a one-letter name", { attendees: ["A"] }, /attend/],
    ["a repeated attendee", { attendees: ["A. Dlamini", "A. Dlamini"] }, /attend/],
    ["more than twenty conditions", { conditions: Array.from({ length: 21 }, (_, i) => `Condition number ${i} to meet`) }, /conditions/],
    ["a condition that is too short", { conditions: ["ok"] }, /condition/],
    ["a rationale that is too short", { rationale: "fine" }, /rationale/],
    ["a meeting date in the future", { meetingDate: "2026-11-07" }, /meeting/],
    ["a meeting date that is not a day", { meetingDate: "Tuesday" }, /meeting/],
  ])("refuses %s", (_name, over, re) => {
    expect(committeeProblems({ ...ok, ...over }, today).join(" | ")).toMatch(re)
  })
})
