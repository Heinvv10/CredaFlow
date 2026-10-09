import { describe, it, expect } from "vitest"
import { isLeadIdShaped, normalizeTab, parseLeadModalParams } from "./lead-modal-url"

describe("isLeadIdShaped", () => {
  it("accepts a cuid-shaped token", () => {
    expect(isLeadIdShaped("clxtestlead00000000000001")).toBe(true)
  })

  it.each([
    ["path traversal", "../../admin/some-path"],
    ["encoded traversal (decoded form)", "../.."],
    ["slash", "a/b"],
    ["dot segment", "a.b"],
    ["percent encoding", "abc%2Fdef"],
    ["query smuggling", "abc?x=1"],
    ["empty", ""],
    ["too short", "abc123"],
    ["too long", "a".repeat(41)],
    ["whitespace", "abc 123def0"],
  ])("rejects %s", (_label, value) => {
    expect(isLeadIdShaped(value)).toBe(false)
  })
})

describe("normalizeTab", () => {
  it("passes valid tabs through and falls back to details otherwise", () => {
    expect(normalizeTab("tasks")).toBe("tasks")
    expect(normalizeTab("appointment")).toBe("appointment")
    expect(normalizeTab("nonsense")).toBe("details")
    expect(normalizeTab(undefined)).toBe("details")
    expect(normalizeTab(null)).toBe("details")
  })
})

describe("parseLeadModalParams", () => {
  it("returns validated state for a well-shaped id", () => {
    expect(parseLeadModalParams("clxtestlead00000000000001", "notes")).toEqual({
      id: "clxtestlead00000000000001",
      tab: "notes",
    })
  })

  it("returns null for a missing or malformed id even with a valid tab", () => {
    expect(parseLeadModalParams(undefined, "notes")).toBeNull()
    expect(parseLeadModalParams("../../admin", "notes")).toBeNull()
  })
})
