import { describe, expect, it } from "vitest"
import { sanitizeNotificationLogError } from "../notifications"

describe("sanitizeNotificationLogError", () => {
  it("keeps notification log errors safe for legacy database encodings", () => {
    expect(sanitizeNotificationLogError("SMTP failed → retry later")).toBe("SMTP failed ? retry later")
  })

  it("preserves ordinary ASCII diagnostics", () => {
    expect(sanitizeNotificationLogError("Provider returned 503: timeout")).toBe("Provider returned 503: timeout")
  })
})
