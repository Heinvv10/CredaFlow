import { describe, expect, it } from "vitest"
import { backoffSeconds } from "./deliver"

describe("SIEM delivery backoff", () => {
  it("doubles from 30 seconds and stops at an hour", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240])
    expect(backoffSeconds(8)).toBe(3600)
    expect(backoffSeconds(50)).toBe(3600)
  })
})
