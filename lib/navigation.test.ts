import { describe, expect, it } from "vitest"
import { STAFF_BADGE_KEYS, badgeDescription } from "./navigation"

describe("badgeDescription", () => {
  // The inbox badge was read as "3 unread messages" and is nothing of the
  // sort — it counts customers waiting on a reply. The label is the whole fix,
  // so it is asserted rather than left to a comment.
  it("says what the inbox badge counts, not 'unread'", () => {
    expect(badgeDescription("inbox", 3)).toBe("3 conversations awaiting a reply")
    expect(badgeDescription("inbox", 3)).not.toMatch(/unread/i)
  })

  it("uses the singular for one", () => {
    expect(badgeDescription("inbox", 1)).toBe("1 conversation awaiting a reply")
    expect(badgeDescription("applications", 1)).toBe(
      "1 application awaiting a decision",
    )
  })

  it("describes every badge key", () => {
    for (const key of STAFF_BADGE_KEYS) {
      const label = badgeDescription(key, 2)
      expect(label.startsWith("2 ")).toBe(true)
      expect(label.length).toBeGreaterThan(3)
    }
  })

  // The badge renders "99+" above 99. The label must carry the real number —
  // "99+ loans in arrears" tells a collections lead nothing they can act on.
  it("carries the true count past the 99+ display cap", () => {
    expect(badgeDescription("collections", 143)).toBe("143 loans in arrears")
  })
})

// Deliberately NOT a test that every nav badgeKey has a description: BADGE_NOUNS
// is a Record over the same union the nav items are typed against, so that state
// is unreachable without a cast. A test that cannot go red is not coverage.
