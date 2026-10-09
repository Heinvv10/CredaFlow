import { describe, it, expect } from "vitest"
import {
  NOTIFICATION_RETENTION_DAYS,
  THROTTLE_RETENTION_DAYS,
  retentionPeriodsAreCoherent,
  notificationPurgeCutoff,
  throttlePurgeCutoff,
} from "./retention"
import { REMINDER_LOOKBACK_DAYS } from "./task-reminder"

const NOW = Date.parse("2026-07-17T12:00:00.000Z")

describe("retention periods", () => {
  // Assert the LITERALS. A test derived from the constant passes at any value,
  // and the value is the whole decision here — see the reasoning in
  // retention.ts, which a reader should be able to argue with.
  it("keeps bell items for exactly 90 days", () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90)
  })

  it("keeps throttle claims for exactly 30 days", () => {
    expect(THROTTLE_RETENTION_DAYS).toBe(30)
  })
})

describe("the throttle period must outlive the reminder window", () => {
  // THE load-bearing invariant of this whole file. A throttle claim uses
  // windowStart = task.dueAt, and the reminder cron re-selects any task with
  // dueAt >= now - REMINDER_LOOKBACK_DAYS. Purge a claim while its task is
  // still inside that window and the next sweep reminds the assignee AGAIN.
  //
  // This is the drift guard: raising REMINDER_LOOKBACK_DAYS past
  // THROTTLE_RETENTION_DAYS would silently start double-sending, and nothing
  // else in the system would notice.
  it("is coherent as configured", () => {
    expect(retentionPeriodsAreCoherent()).toBe(true)
  })

  // The above is a tautology on its own — it passes just as well if the body
  // is replaced by `return true`, i.e. with the guard deleted. These pin the
  // comparison itself by supplying pairs the predicate MUST reject.
  it("rejects a throttle period shorter than the reminder window", () => {
    expect(retentionPeriodsAreCoherent(3, 7)).toBe(false)
  })

  it("rejects equal periods — a claim expiring exactly as the task leaves the window still races", () => {
    expect(retentionPeriodsAreCoherent(7, 7)).toBe(false)
  })

  it("accepts a throttle period that outlives the window", () => {
    expect(retentionPeriodsAreCoherent(30, 7)).toBe(true)
    expect(retentionPeriodsAreCoherent(8, 7)).toBe(true)
  })

  it("holds with a real margin, not by one day", () => {
    expect(THROTTLE_RETENTION_DAYS).toBeGreaterThan(REMINDER_LOOKBACK_DAYS)
    expect(THROTTLE_RETENTION_DAYS / REMINDER_LOOKBACK_DAYS).toBeGreaterThanOrEqual(4)
  })

  it("a claim is only purged well after its task has left the reminder window", () => {
    // A task due exactly at the edge of the lookback is the last one that can
    // still be re-selected. Its claim must survive comfortably past that.
    const lastSelectableDueAt = NOW - REMINDER_LOOKBACK_DAYS * 86_400_000
    expect(throttlePurgeCutoff(NOW).getTime()).toBeLessThan(lastSelectableDueAt)
  })
})

describe("cutoffs", () => {
  it("notification cutoff is 90 days back from the supplied clock", () => {
    expect(notificationPurgeCutoff(NOW).toISOString()).toBe("2026-04-18T12:00:00.000Z")
  })

  it("throttle cutoff is 30 days back from the supplied clock", () => {
    expect(throttlePurgeCutoff(NOW).toISOString()).toBe("2026-06-17T12:00:00.000Z")
  })

  it("both cutoffs are in the past — a purge must never reap the present", () => {
    expect(notificationPurgeCutoff(NOW).getTime()).toBeLessThan(NOW)
    expect(throttlePurgeCutoff(NOW).getTime()).toBeLessThan(NOW)
  })
})
