import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({}) }))

import robots from "./robots"

afterEach(() => vi.unstubAllEnvs())

describe("robots.txt", () => {
  it("disallows everything in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] })
  })
  it("keeps the normal allow-list when DEMO_MODE is unset", async () => {
    vi.stubEnv("DEMO_MODE", "")
    const rules = (await robots()).rules
    const first = Array.isArray(rules) ? rules[0] : rules
    expect(first.allow).toBeDefined()
    expect(first.disallow).not.toBe("/")
  })
})

describe("robots.txt rendering", () => {
  it("is rendered per request, so the runtime DEMO_MODE applies", async () => {
    expect((await import("./robots")).dynamic).toBe("force-dynamic")
  })
})
