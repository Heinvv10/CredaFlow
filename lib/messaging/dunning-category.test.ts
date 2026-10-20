import { describe, expect, it } from "vitest"
import { DUNNING_MESSAGE_CATEGORIES, isDunningCategory } from "./dunning-category"

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
