import { describe, expect, it } from "vitest"
import { automatedDunningLoan, DUNNING_MESSAGE_CATEGORIES, isDunningCategory } from "./dunning-category"

describe("isDunningCategory", () => {
  it.each([...DUNNING_MESSAGE_CATEGORIES])("%s is dunning", (category) => {
    expect(isDunningCategory(category)).toBe(true)
  })

  it.each([undefined, null, "", "statement", "payment_received", "otp", "application_declined", "section129_sent", "lead_task_reminder", "TRANSACTIONAL"])(
    "%s is not dunning: statements, receipts, transactional and statutory messages are never held",
    (category) => {
      expect(isDunningCategory(category as string | undefined)).toBe(false)
    },
  )
})

describe("automatedDunningLoan", () => {
  it.each([
    ["collections:loan_1:reminder_7d:EMAIL:2026-11-01", { loanId: "loan_1", notice: false }],
    ["entity-notice:loan_2:reminder_1d:2026-11-01:cl_9:WHATSAPP", { loanId: "loan_2", notice: false }],
    // The consumer loan_overdue notification, which the 60-DPD DEFAULTED notice also is (lib/notifications.ts).
    ["notification:loan_overdue:loan_3:2026-11-01:SMS", { loanId: "loan_3", notice: true }],
  ])("reads the loan of an automated dunning key: %s", (key, expected) => {
    expect(automatedDunningLoan(key)).toEqual(expected)
  })

  // Staff-initiated messages are deliberately not held by an arrangement or an attorney referral
  // (lib/collections/.claude.md); a stage WhatsApp is staff-initiated too, so its prefix is pinned here.
  it.each([null, undefined, "", "manual-reminder:loan_1:op:SMS", "collections-stage:loan_1:SECTION_129_SENT:WHATSAPP", "collections:", "something-else:loan_1", "notification:payment_received:loan_1:pay_1:SMS", "notification:loan_approved:loan_1:loan_1:SMS"])(
    "reads no loan from %s",
    (key) => {
      expect(automatedDunningLoan(key)).toBeNull()
    },
  )
})
