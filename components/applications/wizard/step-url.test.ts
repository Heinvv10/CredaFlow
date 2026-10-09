import { describe, it, expect } from "vitest"
import { buildStepUrl } from "./step-url"

describe("buildStepUrl", () => {
  it("preserves an existing id param while updating step", () => {
    expect(buildStepUrl("id=abc123&step=1", 2)).toBe("?id=abc123&step=2")
  })

  it("appends step when no query params exist yet", () => {
    expect(buildStepUrl("", 2)).toBe("?step=2")
  })

  it("overwrites an existing step value rather than duplicating it", () => {
    expect(buildStepUrl("step=3&id=xyz", 1)).toBe("?step=1&id=xyz")
  })

  it("preserves unrelated params alongside id", () => {
    expect(buildStepUrl("id=abc123&foo=bar", 4)).toBe("?id=abc123&foo=bar&step=4")
  })
})
