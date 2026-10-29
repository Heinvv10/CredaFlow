import { describe, expect, it } from "vitest"
import { routeLabel } from "./route-label"

describe("routeLabel", () => {
  it.each([
    ["/api/health", "/api/health"],
    ["/api/loans/2f1c8a9e-1b2c-4d3e-8f90-123456789abc/statement", "/api/loans/:id/statement"],
    ["/api/clients/12345", "/api/clients/:id"],
    ["/loans/cm1x2y3z4a5b6c7d8e9f0g1h2", "/loans/:id"],
    ["/api/pasq-link/4f3a9c1d5e7b2a60f8d4c3b2a1e0f9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2/acknowledge", "/api/pasq-link/:id/acknowledge"],
    ["/_next/static/chunks/app-1a2b3c.js", "/_next/static"],
    ["/_next/image", "/_next/image"],
    ["/", "/"],
  ])("%s -> %s", (path, label) => {
    expect(routeLabel(path)).toBe(label)
  })

  it("collapses a flood of distinct unknown paths so a scanner cannot grow the label set", () => {
    const labels = new Set<string>()
    for (let i = 0; i < 2000; i++) labels.add(routeLabel(`/scan/a${i}b/x${i * 7}y/z`))
    expect(labels.size).toBeLessThanOrEqual(501)
    expect(labels.has("other")).toBe(true)
  })
})
