import { describe, expect, it } from "vitest"
import { escalationTarget } from "./escalation"

describe("escalationTarget", () => {
  it("climbs one level per escalation from the pending level, and stops at the top", () => {
    expect(escalationTarget(1, 0, 3)).toBe(2)
    expect(escalationTarget(1, 1, 3)).toBe(3)
    expect(escalationTarget(1, 5, 3)).toBe(3)
    expect(escalationTarget(2, 0, 3)).toBe(3)
    expect(escalationTarget(3, 0, 3)).toBe(3)
  })
})
