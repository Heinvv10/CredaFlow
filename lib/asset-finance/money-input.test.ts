import { describe, expect, it } from "vitest"
import { randsToCents } from "./money-input"

describe("randsToCents", () => {
  it.each([
    ["1500000", 150_000_000],
    ["1 500 000.5", 150_000_050],
    ["R1,500,000.05", 150_000_005],
    ["0.29", 29],
    ["  12.10 ", 1_210],
  ])("%s → %d cents", (input, cents) => {
    expect(randsToCents(input)).toBe(cents)
  })

  it.each(["", "abc", "1.234", "-5", "1.2.3", "R"])("rejects %j", (input) => {
    expect(randsToCents(input)).toBeNull()
  })
})
