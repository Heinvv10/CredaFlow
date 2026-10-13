import { describe, it, expect } from "vitest"
import { safeInternalPath } from "./safe-path"

describe("safeInternalPath", () => {
  it.each(["/dashboard", "/loans/123", "/portal", "/portal/loans/abc-1_2.x~", "/"])("keeps the internal path %s", (p) => {
    expect(safeInternalPath(p)).toBe(p)
  })

  it.each([
    ["backslash after the slash", "/\\evil.example"],
    ["backslash later in the path", "/loans\\evil"],
    ["protocol-relative", "//evil"],
    ["absolute URL", "https://evil"],
    ["javascript scheme", "javascript:alert(1)"],
    ["percent-encoded backslash", "/%5Cevil.example"],
    ["control character", "/loans\u0000x"],
    ["tab", "/\t/evil.example"],
    ["newline", "/loans\n"],
    ["space", "/ evil"],
    ["parent segment", "/portal/../dashboard"],
    ["no leading slash", "dashboard"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, p) => {
    expect(safeInternalPath(p)).toBeNull()
  })
})
