import { afterEach, describe, expect, it, vi } from "vitest"
import robots from "./robots"

afterEach(() => vi.unstubAllEnvs())

describe("robots.txt", () => {
  it("disallows everything in demo mode", () => {
    vi.stubEnv("DEMO_MODE", "true")
    expect(robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] })
  })
  it("keeps the normal allow-list when DEMO_MODE is unset", () => {
    vi.stubEnv("DEMO_MODE", "")
    const rules = robots().rules
    const first = Array.isArray(rules) ? rules[0] : rules
    expect(first.allow).toBeDefined()
    expect(first.disallow).not.toBe("/")
  })
})
