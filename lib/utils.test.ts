import { describe, it, expect } from "vitest"
import { formatDate, formatDateTime, maskEmail, escapeHtml } from "./utils"

// A UTC instant that falls on a DIFFERENT calendar day in SAST (UTC+2):
// 2026-07-11T23:30:00Z is 2026-07-12 01:30 in Africa/Johannesburg. If these
// formatters ever fall back to the runtime's local zone (date-fns' format(),
// or toLocale*() without an explicit timeZone) instead of pinning SAST
// explicitly, this is exactly the case that flips output between a server
// (commonly UTC) and a browser (SAST) — the class of bug behind the React
// #418 hydration mismatches this pinning prevents.
const CROSS_MIDNIGHT_UTC = "2026-07-11T23:30:00.000Z"

describe("formatDate — pinned to Africa/Johannesburg regardless of runtime zone", () => {
  it("renders the SAST calendar date, not the UTC one", () => {
    expect(formatDate(CROSS_MIDNIGHT_UTC)).toBe("12 Jul 2026")
  })

  it("accepts a Date object as well as a string", () => {
    expect(formatDate(new Date(CROSS_MIDNIGHT_UTC))).toBe("12 Jul 2026")
  })
})

describe("formatDateTime — pinned to Africa/Johannesburg regardless of runtime zone", () => {
  it("renders the SAST calendar date and clock time, not the UTC ones", () => {
    expect(formatDateTime(CROSS_MIDNIGHT_UTC)).toBe("12 Jul 2026 01:30")
  })
})

describe("maskEmail", () => {
  it("keeps first + last char of the local part and the whole domain", () => {
    expect(maskEmail("naledi@acme-lending.example")).toBe("n****i@acme-lending.example")
  })
  it("masks a 2-char local part to first char + one star", () => {
    expect(maskEmail("jo@example.com")).toBe("j*@example.com")
  })
  it("masks a 1-char local part to a single star", () => {
    expect(maskEmail("a@example.com")).toBe("*@example.com")
  })
  it("returns a safe placeholder for a string with no @", () => {
    expect(maskEmail("not-an-email")).toBe("***")
  })
})

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" tag='y'>&`)).toBe("&lt;a href=&quot;x&quot; tag=&#39;y&#39;&gt;&amp;")
  })
  it("replaces ampersand first so entities are not double-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;")
  })
  it("leaves a plain masked value unchanged", () => {
    expect(escapeHtml("d****e@acme-lending.example")).toBe("d****e@acme-lending.example")
    expect(escapeHtml("*********9087")).toBe("*********9087")
  })
})
