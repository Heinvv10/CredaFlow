import { describe, it, expect } from "vitest"
import {
  reminderChannelFor,
  taskReminderThrottleKey,
  buildTaskReminderBell,
  buildTaskReminderWhatsApp,
  buildTaskReminderEmail,
  REMINDER_LOOKBACK_DAYS,
} from "./task-reminder"

const DUE = new Date("2026-07-17T10:30:00.000Z")

describe("reminderChannelFor", () => {
  it("prefers WhatsApp when the staff member has a phone", () => {
    expect(reminderChannelFor({ waEnabled: true, phone: "0821234567", email: "a@b.co.za" })).toBe("WHATSAPP")
  })

  it("falls back to email when there is no phone — 0 of 5 active staff on staging have one", () => {
    // This is the whole reason the fallback exists. A WhatsApp-only reminder
    // would ship inert: every reminder would silently go nowhere.
    expect(reminderChannelFor({ waEnabled: true, phone: null, email: "a@b.co.za" })).toBe("EMAIL")
    expect(reminderChannelFor({ waEnabled: true, phone: "   ", email: "a@b.co.za" })).toBe("EMAIL")
  })

  it("falls back to email when WhatsApp is disabled tenant-wide, rather than dropping the reminder", () => {
    expect(reminderChannelFor({ waEnabled: false, phone: "0821234567", email: "a@b.co.za" })).toBe("EMAIL")
  })

  it("is NONE only when there is genuinely nowhere to send", () => {
    expect(reminderChannelFor({ waEnabled: false, phone: null, email: null })).toBe("NONE")
    expect(reminderChannelFor({ waEnabled: true, phone: "", email: "" })).toBe("NONE")
  })
})

describe("taskReminderThrottleKey", () => {
  it("is per-task, so two due tasks do not suppress each other", () => {
    expect(taskReminderThrottleKey("task_a")).toBe("lead-task-reminder:task_a")
    expect(taskReminderThrottleKey("task_a")).not.toBe(taskReminderThrottleKey("task_b"))
  })
})

describe("REMINDER_LOOKBACK_DAYS", () => {
  it("is exactly 7 days", () => {
    // Assert the VALUE, not just that a floor exists: a test derived from the
    // constant passes at 3650 too, and this floor is the only thing stopping a
    // cron outage (or the first run after wiring) firing every historical due
    // task at once.
    expect(REMINDER_LOOKBACK_DAYS).toBe(7)
  })
})

describe("task title cap inside the body", () => {
  // MAX_TITLE_IN_BODY is module-private, so pin it through behaviour.
  //
  // This is NOT redundant with validateNewLeadTask's MAX_TASK_TITLE: the
  // automation engine (lib/automation/actions.ts) writes AgentTask rows
  // directly and never goes through that validator, so for an automation-created
  // task this is the ONLY thing bounding what the title puts into a WhatsApp or
  // email body.
  it("truncates a 200-char title to exactly 120 chars including the ellipsis", () => {
    const bell = buildTaskReminderBell({ taskTitle: "a".repeat(200), leadName: "L", dueAt: DUE })
    expect(bell.title).toBe(`Task due: ${"a".repeat(119)}…`)
  })

  it("leaves a title at the cap untouched", () => {
    const bell = buildTaskReminderBell({ taskTitle: "a".repeat(120), leadName: "L", dueAt: DUE })
    expect(bell.title).toBe(`Task due: ${"a".repeat(120)}`)
  })
})

// ── The bodies are the sink ────────────────────────────────────────────────
// Lead.firstName/lastName are public-form input (app/api/website/apply accepts
// them on a truthiness check alone). These pin that a member of the public
// cannot author lines in a message delivered to staff from the lender's own
// verified WhatsApp identity.
describe("reminder bodies — untrusted lead name", () => {
  const ATTACK = "Thabo\n\nAcme Lending: your payout is on hold, pay R250 to 123456789"

  it("the lead name cannot open a new line in the WhatsApp body", () => {
    const body = buildTaskReminderWhatsApp({
      taskTitle: "Call back",
      leadName: ATTACK,
      dueAt: DUE,
      url: "https://app.example/crm/leads/1",
    })
    // The defence is containment, not word-blocking: the payload is flattened
    // onto the "Lead:" line, where it reads as an absurdly long name rather
    // than as the separate, authoritative-looking paragraph the attacker
    // wrote. The body therefore has exactly the 5 lines this template writes.
    const lines = body.split("\n")
    expect(lines).toHaveLength(5)
    expect(lines.filter((l) => l.startsWith("Lead: "))).toHaveLength(1)
    expect(lines[4]).toBe("Open it here: https://app.example/crm/leads/1")
    // And the 40-char cap truncates the payload before its actual demand.
    expect(body).not.toContain("pay R250")
  })

  it("strips newlines from the lead name in the bell item", () => {
    const bell = buildTaskReminderBell({ taskTitle: "Call back", leadName: ATTACK, dueAt: DUE })
    expect(bell.body).not.toContain("\n")
    expect(bell.body).not.toContain("pay R250")
  })

  it("HTML-escapes the lead name in the email — this one really is an HTML context", () => {
    const { html } = buildTaskReminderEmail({
      taskTitle: "Call back",
      leadName: '<a href="https://evil.example">click</a>',
      dueAt: DUE,
      url: "https://app.example/crm/leads/1",
      assigneeName: "Sipho",
    })
    expect(html).not.toContain('<a href="https://evil.example">')
    expect(html).toContain("&lt;a href=")
  })

  it("HTML-escapes the task title in the email", () => {
    const { html, subject } = buildTaskReminderEmail({
      taskTitle: '<img src=x onerror="alert(1)">',
      leadName: "Thabo Nkosi",
      dueAt: DUE,
      url: "https://app.example/crm/leads/1",
      assigneeName: "Sipho",
    })
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x")
    // The subject is a plain-text header, so it is flattened but not escaped.
    expect(subject).toContain("Task due:")
  })

  it("HTML-escapes the assignee name — User.name is free text from the admin form", () => {
    const { html } = buildTaskReminderEmail({
      taskTitle: "Call back",
      leadName: "Thabo Nkosi",
      dueAt: DUE,
      url: "https://app.example/crm/leads/1",
      assigneeName: '<script>alert(1)</script>',
    })
    expect(html).not.toContain("<script>")
  })
})

describe("reminder bodies — content", () => {
  it("the WhatsApp body carries the task, lead, due time and a link", () => {
    const body = buildTaskReminderWhatsApp({
      taskTitle: "Call back about payslips",
      leadName: "Thabo Nkosi",
      dueAt: DUE,
      url: "https://app.example/crm/leads/abc",
    })
    expect(body).toContain("Call back about payslips")
    expect(body).toContain("Thabo Nkosi")
    expect(body).toContain("https://app.example/crm/leads/abc")
  })

  it("does not invite a reply — inbound WhatsApp routes by phone to a Contact, not to a task", () => {
    // A staff reply would land in the customer inbox path and never reach the
    // task, so the copy must not promise it. (Copy may only promise what the
    // code does.)
    const body = buildTaskReminderWhatsApp({
      taskTitle: "t",
      leadName: "l",
      dueAt: DUE,
      url: "https://app.example/x",
    })
    expect(body.toLowerCase()).not.toContain("reply")
  })

  it("renders the due time in SAST, not UTC — 10:30Z is 12:30 in Johannesburg", () => {
    const bell = buildTaskReminderBell({ taskTitle: "t", leadName: "l", dueAt: DUE })
    expect(bell.body).toContain("12:30")
  })
})
