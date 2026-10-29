import { beforeEach, describe, expect, it } from "vitest"
import { createRouteLabeler } from "./route-label"

const manifest = {
  staticRoutes: [
    { page: "/", regex: "^/(?:/)?$" },
    { page: "/api/health", regex: "^/api/health(?:/)?$" },
    { page: "/api/cron/asset-finance-telematics-closure", regex: "^/api/cron/asset\\-finance\\-telematics\\-closure(?:/)?$" },
  ],
  dynamicRoutes: [
    { page: "/api/loans/[id]/statement", regex: "^/api/loans/([^/]+?)/statement(?:/)?$" },
    { page: "/api/pasq-link/[token]/acknowledge", regex: "^/api/pasq\\-link/([^/]+?)/acknowledge(?:/)?$" },
  ],
}

describe("route label from the Next routes manifest", () => {
  const label = createRouteLabeler(manifest)

  it.each([
    ["/api/health", "/api/health"],
    ["/api/health/", "/api/health"],
    ["/", "/"],
    ["/api/cron/asset-finance-telematics-closure", "/api/cron/asset-finance-telematics-closure"],
    ["/api/loans/2f1c8a9e-1b2c-4d3e-8f90-123456789abc/statement", "/api/loans/[id]/statement"],
    ["/api/loans/someone@lender.example/statement", "/api/loans/[id]/statement"],
    ["/api/pasq-link/4f3a9c1d5e7b2a60f8d4c3b2a1e0f9d8c7b6a5f4/acknowledge", "/api/pasq-link/[token]/acknowledge"],
    ["/_next/static/chunks/app-1a2b3c.js", "/_next/static"],
  ])("%s -> %s", (path, expected) => {
    expect(label(path)).toBe(expected)
  })

  it("puts every path no route matches under one label, so a 404 flood adds no series", () => {
    const labels = new Set<string>()
    for (let i = 0; i < 5000; i++) labels.add(label(`/scan/a${i}b/x${i * 7}y.php`))
    expect([...labels]).toEqual(["unmatched"])
  })

  it("ignores the query string", () => {
    expect(label("/api/health?probe=1")).toBe("/api/health")
  })
})

describe("route label without a manifest (dev, tests)", () => {
  // A fresh labeler per test: its label cap is state, and the cap test must not depend on test order.
  let label: (pathname: string) => string
  beforeEach(() => {
    label = createRouteLabeler(null)
  })

  it.each([
    ["/api/health", "/api/health"],
    ["/api/cron/asset-finance-telematics-closure", "/api/cron/asset-finance-telematics-closure"],
    ["/api/cron/website-chat-handoffs", "/api/cron/website-chat-handoffs"],
    ["/api/loans/2f1c8a9e-1b2c-4d3e-8f90-123456789abc/statement", "/api/loans/:id/statement"],
    ["/api/clients/12345", "/api/clients/:id"],
    ["/loans/cm1x2y3z4a5b6c7d8e9f0g1h2", "/loans/:id"],
    ["/api/pasq-link/4f3a9c1d5e7b2a60f8d4c3b2a1e0f9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2/acknowledge", "/api/pasq-link/:id/acknowledge"],
    ["/api/users/someone@lender.example", "/api/users/:id"],
    ["/files/report.final.pdf", "/files/:id"],
    ["/api/tokens/aB3dE5gH7jK9mN1pQ3sT", "/api/tokens/:id"],
    ["/", "/"],
    ["/graph/v19.0/messages", "/graph/v19.0/messages"],
    ["/graph/v19.0.1.7/messages", "/graph/:id/messages"],
    // A UUID whose characters are all hex letters has no digit to give it away.
    ["/api/loans/abcdefab-cdef-abcd-efab-cdefabcdefab/statement", "/api/loans/:id/statement"],
  ])("%s -> %s", (path, expected) => {
    expect(label(path)).toBe(expected)
  })

  it("caps distinct labels so a scanner cannot grow the series set", () => {
    const labels = new Set<string>()
    for (let i = 0; i < 5000; i++) labels.add(label(`/s${"abcdefghij"[i % 10]}${"klmnopqrst"[(i / 10 | 0) % 10]}/${"uvwxyzabcd"[(i / 100 | 0) % 10]}x/${i % 7}`))
    expect(labels.size).toBeLessThanOrEqual(1001)
  })
})

describe("route label with a malformed manifest", () => {
  it.each([
    ["not an object", "oops"],
    ["no route arrays", {}],
    ["routes without a page", { staticRoutes: [{ regex: "^/$" }], dynamicRoutes: [] }],
    ["routes that are not arrays", { staticRoutes: {}, dynamicRoutes: 3 }],
    ["an invalid regex", { staticRoutes: [], dynamicRoutes: [{ page: "/a/[id]", regex: "([" }] }],
  ])("%s: never throws, falls back to path shapes", (_name, manifest) => {
    const label = createRouteLabeler(manifest as never)
    expect(() => label("/api/health")).not.toThrow()
    expect(label("/api/health")).toBe("/api/health")
    expect(label("/api/loans/12345/statement")).toBe("/api/loans/:id/statement")
  })
})
