import { describe, it, expect } from "vitest"
import {
  validateNewLeadTask,
  isTaskOverdue,
  isTaskPriority,
  isTaskStatus,
  MAX_TASK_TITLE,
  MAX_TASK_DESCRIPTION,
} from "./lead-tasks"

describe("validateNewLeadTask", () => {
  it("accepts a minimal task and defaults priority to MEDIUM", () => {
    const r = validateNewLeadTask({ title: "Call back about payslips" })
    expect(r).toEqual({
      ok: true,
      value: {
        title: "Call back about payslips",
        description: null,
        priority: "MEDIUM",
        dueAt: null,
        assigneeId: null,
      },
    })
  })

  it("trims the title and rejects one that is only whitespace", () => {
    expect(validateNewLeadTask({ title: "  Call  " })).toMatchObject({
      ok: true,
      value: { title: "Call" },
    })
    expect(validateNewLeadTask({ title: "   " })).toEqual({ ok: false, error: "Title is required" })
  })

  it("requires a title of the right type — a missing or non-string title is a 400, not a crash", () => {
    expect(validateNewLeadTask({}).ok).toBe(false)
    expect(validateNewLeadTask({ title: 42 }).ok).toBe(false)
    expect(validateNewLeadTask({ title: null }).ok).toBe(false)
  })

  // The cap VALUE is the thing under test, not merely "a cap exists". Sizing
  // the fixtures off MAX_TASK_TITLE would pass at any value — including
  // 1_000_000 — which pins nothing, because the cap is justified by what may
  // land in a WhatsApp/email reminder body. So assert the literal first, then
  // use hard-coded lengths.
  it("caps the title at exactly 120 — it is interpolated into a reminder body", () => {
    expect(MAX_TASK_TITLE).toBe(120)
    expect(validateNewLeadTask({ title: "a".repeat(120) }).ok).toBe(true)
    expect(validateNewLeadTask({ title: "a".repeat(121) })).toMatchObject({ ok: false })
  })

  it("caps the description at exactly 2000", () => {
    expect(MAX_TASK_DESCRIPTION).toBe(2000)
    expect(validateNewLeadTask({ title: "t", description: "a".repeat(2000) }).ok).toBe(true)
    expect(validateNewLeadTask({ title: "t", description: "a".repeat(2001) }).ok).toBe(false)
  })

  it("treats an empty description/priority/dueAt/assignee as absent, not invalid", () => {
    // The form posts "" for untouched optional fields.
    const r = validateNewLeadTask({ title: "t", description: "", priority: "", dueAt: "", assigneeId: "" })
    expect(r).toMatchObject({ ok: true, value: { description: null, priority: "MEDIUM", dueAt: null, assigneeId: null } })
  })

  it("rejects a priority outside the allow-list", () => {
    expect(validateNewLeadTask({ title: "t", priority: "URGENT" })).toMatchObject({
      ok: true,
      value: { priority: "URGENT" },
    })
    expect(validateNewLeadTask({ title: "t", priority: "🔥" })).toEqual({ ok: false, error: "Invalid priority" })
    expect(validateNewLeadTask({ title: "t", priority: "medium" })).toEqual({ ok: false, error: "Invalid priority" })
  })

  it("rejects an unparseable due date instead of passing an Invalid Date to prisma", () => {
    // `new Date("banana")` yields an Invalid Date object rather than throwing,
    // so without the NaN check this reaches the DB as an opaque 500.
    expect(validateNewLeadTask({ title: "t", dueAt: "banana" })).toEqual({ ok: false, error: "Invalid due date" })
    expect(validateNewLeadTask({ title: "t", dueAt: 1234 })).toEqual({ ok: false, error: "Invalid due date" })
  })

  it("parses a valid ISO due date", () => {
    const r = validateNewLeadTask({ title: "t", dueAt: "2026-08-01T09:00:00.000Z" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.dueAt?.toISOString()).toBe("2026-08-01T09:00:00.000Z")
  })
})

describe("isTaskPriority / isTaskStatus", () => {
  it("accepts only the exact allow-listed values", () => {
    expect(isTaskPriority("HIGH")).toBe(true)
    expect(isTaskPriority("high")).toBe(false)
    expect(isTaskStatus("COMPLETED")).toBe(true)
    expect(isTaskStatus("DONE")).toBe(false)
  })

  it("does not walk the prototype chain", () => {
    // A guard written with `in` or a bare object lookup would pass these.
    expect(isTaskPriority("constructor")).toBe(false)
    expect(isTaskStatus("toString")).toBe(false)
  })
})

describe("isTaskOverdue", () => {
  const now = Date.parse("2026-07-17T12:00:00.000Z")

  it("is overdue when an open task's due time has passed", () => {
    expect(isTaskOverdue({ status: "PENDING", dueAt: new Date(now - 1000) }, now)).toBe(true)
    expect(isTaskOverdue({ status: "IN_PROGRESS", dueAt: new Date(now - 1000) }, now)).toBe(true)
  })

  it("is not overdue before the due time", () => {
    expect(isTaskOverdue({ status: "PENDING", dueAt: new Date(now + 1000) }, now)).toBe(false)
  })

  it("is never overdue without a due date", () => {
    expect(isTaskOverdue({ status: "PENDING", dueAt: null }, now)).toBe(false)
  })

  it("is never overdue once closed — a completed task must not nag", () => {
    expect(isTaskOverdue({ status: "COMPLETED", dueAt: new Date(now - 1000) }, now)).toBe(false)
    expect(isTaskOverdue({ status: "CANCELLED", dueAt: new Date(now - 1000) }, now)).toBe(false)
  })

  it("accepts a serialised date string — the panel receives JSON, not Date objects", () => {
    expect(isTaskOverdue({ status: "PENDING", dueAt: new Date(now - 1000).toISOString() }, now)).toBe(true)
  })
})
