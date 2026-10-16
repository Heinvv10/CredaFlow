import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { BORROWER_NOTIFICATION_STATUS, borrowerNotificationStatus } from "./notification-status"

// Review of #152: every status a NotificationLog writer produces, and what the
// borrower is told for it.
describe("borrowerNotificationStatus", () => {
  it.each([
    ["sent", "sent"],
    ["delivered", "sent"],
    ["read", "sent"],
    ["simulated", "simulated"],
    ["pending", "pending"],
    ["queued", "pending"],
    ["review_required", "pending"],
    ["reconciliation_required", "pending"],
    ["failed", "not_delivered"],
    ["blocked", "not_delivered"],
    ["skipped", "not_delivered"],
    ["expired", "not_delivered"],
    ["suppressed_by_consent", "not_delivered"],
  ])("%s → %s", (status, shown) => {
    expect(borrowerNotificationStatus(status)).toBe(shown)
  })

  it("never claims an unknown state was sent", () => {
    expect(borrowerNotificationStatus("something_new")).toBe("pending")
  })

  // A writer that starts producing a new status literal must be mapped here.
  it("maps every status literal the writers write", () => {
    const root = path.join(__dirname, "..", "..")
    const writers = [
      "lib/notifications.ts", "lib/notifications/status.ts", "lib/messaging/dispatch-control.ts", "lib/messaging/retry.ts",
      "lib/messaging/reconcile-held-message.ts", "lib/messaging/staff-task-reminder.ts",
      "app/api/cron/licence-expiry/route.ts", "app/api/cron/insurance-renewal/route.ts",
    ]
    const literals = new Set<string>()
    for (const file of writers) {
      const source = readFileSync(path.join(root, file), "utf8")
      for (const m of source.matchAll(/(?:status: |return |case "[a-z_]+": return )"([a-z_]+)"/g)) literals.add(m[1])
      for (const m of source.matchAll(/\? "([a-z_]+)" : "([a-z_]+)"/g)) { literals.add(m[1]); literals.add(m[2]) }
    }
    expect(literals.size).toBeGreaterThan(5)
    for (const status of literals) expect(Object.keys(BORROWER_NOTIFICATION_STATUS)).toContain(status)
  })
})
