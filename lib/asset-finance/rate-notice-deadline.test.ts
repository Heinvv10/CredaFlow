import { describe, expect, it } from "vitest"
import { rateNoticeDeadline, deadlineLevel, rateNoticeDispatchStatus } from "./rate-notice-deadline"
describe("NCA variable-rate written notice deadline", () => {
  it("counts 30 SA business days from actual effectiveness across Easter and public holidays", () => {
    expect(rateNoticeDeadline("2026-04-02")).toEqual({ dueOn: "2026-05-20", escalateOn: "2026-05-18" })
  })
  it("distinguishes approaching, due and historical breach", () => {
    expect(deadlineLevel("2026-05-20", "2026-05-17", null)).toBe(0)
    expect(deadlineLevel("2026-05-20", "2026-05-18", null)).toBe(1)
    expect(deadlineLevel("2026-05-20", "2026-05-20", null)).toBe(2)
    expect(deadlineLevel("2026-05-20", "2026-05-21", null)).toBe(3)
    expect(deadlineLevel("2026-05-20", "2026-05-25", "2026-05-22")).toBe(3)
    expect(deadlineLevel("2026-05-20", "2026-05-25", "2026-05-20")).toBe(0)
  })
})

it("distinguishes later proof of timely dispatch from actual late dispatch without rewriting the escalation history", () => {
  expect(rateNoticeDispatchStatus("2026-05-20", "2026-05-22", null)).toBe("OVERDUE_UNVERIFIED")
  expect(rateNoticeDispatchStatus("2026-05-20", "2026-05-22", "2026-05-19")).toBe("TIMELY_DISPATCH")
  expect(rateNoticeDispatchStatus("2026-05-20", "2026-05-22", "2026-05-22")).toBe("LATE_DISPATCH")
})
