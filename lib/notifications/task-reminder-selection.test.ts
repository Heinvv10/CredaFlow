import { describe, it, expect } from "vitest"
import {
  unclaimedTasks,
  taskReminderClaimId,
  throttleRowClaimId,
  taskReminderThrottleKey,
} from "./task-reminder"

// The reminder cron's dedupe rests entirely on matching a task against the
// NotificationThrottle rows that already exist. These pin that matching.
// Without them the "remind exactly once" claim is unpinned — which is how a
// task ends up reminded twice, or silently never.

const DUE = new Date("2026-07-17T10:30:00.000Z")
const OTHER_DUE = new Date("2026-07-18T10:30:00.000Z")

describe("claim identity", () => {
  it("has the exact wire format both sides depend on", () => {
    // Assert the LITERAL, not `claimId(x) === claimId(x)`. That comparison is a
    // tautology: it holds even if claimId returns a constant, which is exactly
    // the bug it claims to detect (every lookup would then match and every task
    // would be suppressed forever).
    expect(taskReminderClaimId("task_1", DUE)).toBe("lead-task-reminder:task_1@1784284200000")
    expect(DUE.getTime()).toBe(1784284200000)
  })

  it("both sides of the comparison agree — the cron looks up by one and builds the DB side with the other", () => {
    // Paired with the literal above, this is no longer vacuous: the literal
    // pins the format, and this pins that throttleRowClaimId produces it too.
    // If they diverge, every lookup misses and every task reminds on every run.
    const fromRow = throttleRowClaimId({
      channelKey: taskReminderThrottleKey("task_1"),
      windowStart: DUE,
    })
    expect(fromRow).toBe("lead-task-reminder:task_1@1784284200000")
    expect(taskReminderClaimId("task_1", DUE)).toBe(fromRow)
  })

  it("is per due time, not just per task", () => {
    // windowStart = the task's dueAt. Rescheduling is a different claim.
    expect(taskReminderClaimId("task_1", DUE)).not.toBe(taskReminderClaimId("task_1", OTHER_DUE))
  })

  it("is per task", () => {
    expect(taskReminderClaimId("task_1", DUE)).not.toBe(taskReminderClaimId("task_2", DUE))
  })
})

describe("unclaimedTasks", () => {
  const t1 = { id: "task_1", dueAt: DUE }
  const t2 = { id: "task_2", dueAt: DUE }

  it("keeps a task with no claim", () => {
    expect(unclaimedTasks([t1, t2], new Set())).toEqual([t1, t2])
  })

  it("drops a task already claimed for this due time — the dedupe", () => {
    const claimed = new Set([taskReminderClaimId("task_1", DUE)])
    expect(unclaimedTasks([t1, t2], claimed)).toEqual([t2])
  })

  it("keeps a rescheduled task even though its OLD due time is claimed", () => {
    // Staff moved task_1 to a new dueAt. The old claim must not suppress the
    // new reminder — that is the whole point of keying on dueAt.
    const claimed = new Set([taskReminderClaimId("task_1", DUE)])
    const rescheduled = { id: "task_1", dueAt: OTHER_DUE }
    expect(unclaimedTasks([rescheduled], claimed)).toEqual([rescheduled])
  })

  it("does not confuse two tasks that share a due time", () => {
    const claimed = new Set([taskReminderClaimId("task_1", DUE)])
    expect(unclaimedTasks([t2], claimed)).toEqual([t2])
  })

  it("drops a task with no due date — there is nothing to be due for", () => {
    expect(unclaimedTasks([{ id: "task_3", dueAt: null }], new Set())).toEqual([])
  })

  it("an unrelated claim does not suppress anything", () => {
    const claimed = new Set(["portal-identity-notice:someone@example.com@123"])
    expect(unclaimedTasks([t1], claimed)).toEqual([t1])
  })
})
