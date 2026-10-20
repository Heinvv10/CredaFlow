import { describe, expect, it } from "vitest"
import { automatedDunningLoanId, DUNNING_MESSAGE_CATEGORIES, isDunningCategory } from "./dunning-category"

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

describe("automatedDunningLoanId", () => {
  it.each([
    ["collections:loan_1:reminder_7d:EMAIL:2026-11-01", "loan_1"],
    ["entity-notice:loan_2:reminder_1d:2026-11-01:cl_9:WHATSAPP", "loan_2"],
  ])("reads the loan of an automated dunning key: %s", (key, loanId) => {
    expect(automatedDunningLoanId(key)).toBe(loanId)
  })

  // Staff-initiated messages are deliberately not held by an arrangement or an attorney referral
  // (lib/collections/.claude.md), and a notification key carries no loan.
  it.each([null, undefined, "", "manual-reminder:loan_1:op:SMS", "collections-stage:loan_1:SECTION_129_SENT:WHATSAPP", "collections:", "something-else:loan_1"])(
    "reads no loan from %s",
    (key) => {
      expect(automatedDunningLoanId(key)).toBeNull()
    },
  )
})
