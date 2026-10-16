import { describe, expect, it } from "vitest"
import { scheduleDisplayStatus, scheduleRowStatus } from "./schedule-status"
import {
  ELIZE_SHORT_CENTS,
  elizeScheduleAsAudited,
  kabeloScheduleAsAudited,
} from "./__fixtures__/fairscore-audit-schedules"

// The audit's "today": Elize's #5 (17 Sep) was then 29 days overdue.
const AUDIT_DAY = new Date("2026-10-16T12:00:00.000Z")

describe("scheduleRowStatus", () => {
  it("stores PENDING for a row with nothing paid, never PARTIAL", () => {
    expect(scheduleRowStatus(0, 254_100)).toBe("PENDING")
  })
  it("stores PARTIAL only when some money was applied", () => {
    expect(scheduleRowStatus(254_100 - ELIZE_SHORT_CENTS, 254_100)).toBe("PARTIAL")
  })
  it("stores PAID once the row is covered", () => {
    expect(scheduleRowStatus(254_100, 254_100)).toBe("PAID")
  })
})

describe("scheduleDisplayStatus on Elize's audited schedule", () => {
  const shown = elizeScheduleAsAudited().map((row) => scheduleDisplayStatus(row, AUDIT_DAY))

  it("shows #1–#4 Paid and #5 Partial", () => {
    expect(shown.slice(0, 4)).toEqual(["PAID", "PAID", "PAID", "PAID"])
    expect(shown[4]).toBe("PARTIAL")
  })

  it("shows the instalment due 17 Oct as Upcoming, never Partial", () => {
    // #6 is due 17 Oct 2026, the day after the audit.
    expect(shown[5]).toBe("UPCOMING")
  })

  it("shows every future instalment #6–#18 as Upcoming although stored PARTIAL", () => {
    expect(shown.slice(5)).toEqual(Array(13).fill("UPCOMING"))
  })
})

describe("scheduleDisplayStatus", () => {
  it("shows an unpaid row due today or earlier as Due", () => {
    const kabelo = kabeloScheduleAsAudited()
    // #4 fell due 1 Jun 2026 and nothing was paid.
    expect(scheduleDisplayStatus(kabelo[3], AUDIT_DAY)).toBe("DUE")
    const dueToday = { ...kabelo[3], dueDate: new Date("2026-10-16T06:00:00.000Z") }
    expect(scheduleDisplayStatus(dueToday, AUDIT_DAY)).toBe("DUE")
  })

  it("keeps a staff OVERDUE flag", () => {
    const row = { ...kabeloScheduleAsAudited()[3], status: "OVERDUE" as const }
    expect(scheduleDisplayStatus(row, AUDIT_DAY)).toBe("OVERDUE")
  })
})
