import { describe, expect, it } from "vitest"
import {
  createWebsiteSubmissionKey,
  fingerprintWebsiteSubmissionMaterial,
  parseStoredWebsiteSubmissionAttempt,
} from "./website-submission-attempt"

describe("website submission attempts", () => {
  it("creates and parses a valid browser submission attempt", async () => {
    const attempt = {
      fingerprint: await fingerprintWebsiteSubmissionMaterial({
        firstName: "Synthetic",
        amount: "5000",
      }),
      key: createWebsiteSubmissionKey(),
    }

    expect(parseStoredWebsiteSubmissionAttempt(JSON.stringify(attempt))).toEqual(attempt)
  })

  it("changes the fingerprint when material application data changes", async () => {
    const first = await fingerprintWebsiteSubmissionMaterial({ amount: "5000" })
    const changed = await fingerprintWebsiteSubmissionMaterial({ amount: "5001" })

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(changed).toMatch(/^[0-9a-f]{64}$/)
    expect(changed).not.toBe(first)
  })

  it.each([
    null,
    "",
    "not-json",
    JSON.stringify({ fingerprint: "short", key: createWebsiteSubmissionKey() }),
    JSON.stringify({ fingerprint: "a".repeat(64), key: "not-a-uuid" }),
  ])("rejects an invalid stored attempt", (raw) => {
    expect(parseStoredWebsiteSubmissionAttempt(raw)).toBeNull()
  })
})
