import { describe, expect, it } from "vitest"
import { safeCallbackPath } from "./safe-callback-path"

const FALLBACK = "/dashboard"

describe("safeCallbackPath", () => {
  it.each(["/dashboard", "/portal/loans/abc", "/portal/loans?tab=2", "/settings/users#top", "/a\\b"])(
    "keeps the same-origin path %s",
    (raw) => expect(safeCallbackPath(raw, FALLBACK)).toBe(raw),
  )

  it.each([
    "//evil.example",
    "//evil.example/dashboard",
    "/\\evil.example",
    "/\\/evil.example",
    "https://evil.example",
    "http://evil.example/dashboard",
    "javascript:alert(1)",
    "evil.example",
    "dashboard",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\u0000/evil.example",
    "",
  ])("falls back for %j", (raw) => expect(safeCallbackPath(raw, FALLBACK)).toBe(FALLBACK))

  it("falls back when there is no value", () => {
    expect(safeCallbackPath(null, FALLBACK)).toBe(FALLBACK)
    expect(safeCallbackPath(undefined, FALLBACK)).toBe(FALLBACK)
  })
})
