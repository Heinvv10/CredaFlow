/**
 * Pins DUNNING_MESSAGE_CATEGORIES against what the reminder senders actually pass
 * as `category`. A new reminder category that is not added to the list would have
 * its retries silently left out of the client hold (lib/messaging/retry.ts), so it
 * fails here until it is. Reads the sender source files: the strings live in call
 * sites, and there is no registry to import them from.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DUNNING_MESSAGE_CATEGORIES } from "./dunning-category"

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")
const literals = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => m[1])

// Categories a sender passes that are deliberately NOT dunning. A new category in a
// sender file fails below until it is classified: added to the list, or here.
const NOT_DUNNING = new Set([
  "payment_received", // app/api/notifications/payment: the receipt, not the reminder
])

// Each reminder sender, and how it names its category.
const SENDERS: { file: string; pattern: RegExp }[] = [
  { file: "lib/collections/reminders.ts", pattern: /category:\s*"([a-z_0-9]+)"/g },
  { file: "app/api/collections/[loanId]/reminder/route.ts", pattern: /category:\s*"([a-z_0-9]+)"/g },
  { file: "app/api/loans/[id]/collections-stage/route.ts", pattern: /category:\s*"([a-z_0-9]+)"/g },
  { file: "app/api/notifications/payment/route.ts", pattern: /category:\s*"([a-z_0-9]+)"/g },
  // The payment-reminders cron passes its NOTE_TYPE as the category.
  { file: "app/api/cron/payment-reminders/route.ts", pattern: /const NOTE_TYPE\s*=\s*"([a-z_0-9]+)"/g },
  // lib/notifications.ts passes the event name as the category: the overdue events.
  { file: "lib/notifications.ts", pattern: /\|\s*"(loan_overdue[a-z_0-9]*)"/g },
]

describe("DUNNING_MESSAGE_CATEGORIES against the reminder senders", () => {
  it.each(SENDERS)("$file: finds its category and every one is classified (dunning, or known not to be)", ({ file, pattern }) => {
    const found = literals(read(file), pattern)
    // A refactor that moves the string must fail loudly, not pass on an empty match.
    expect(found.length, `no category found in ${file}`).toBeGreaterThan(0)
    for (const category of found) {
      const classified = DUNNING_MESSAGE_CATEGORIES.has(category) || NOT_DUNNING.has(category)
      expect(classified, `${file} sends category "${category}": add it to DUNNING_MESSAGE_CATEGORIES (a reminder) or to NOT_DUNNING in this test`).toBe(true)
    }
  })

  it("a category is never both dunning and known-not-dunning", () => {
    for (const category of NOT_DUNNING) expect(DUNNING_MESSAGE_CATEGORIES.has(category), category).toBe(false)
  })

  it("every category in the list is sent by one of these senders (no dead entry)", () => {
    const sent = new Set(SENDERS.flatMap(({ file, pattern }) => literals(read(file), pattern)))
    // The 1d/7d overdue variants are sent via lib/notifications.ts's template-event naming.
    for (const category of DUNNING_MESSAGE_CATEGORIES) {
      const known = sent.has(category) || category === "loan_overdue_1d" || category === "loan_overdue_7d"
      expect(known, `"${category}" is in the list but no sender passes it`).toBe(true)
    }
  })
})
