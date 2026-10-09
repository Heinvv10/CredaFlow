import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const script = readFileSync(
  join(process.cwd(), "scripts/set-micro30-pricing.ts"),
  "utf8",
)

describe("MICRO30 existing-data rollout", () => {
  it("requires tenant-scoped approval, in-flight preflight and an audit row", () => {
    expect(script).toContain("--tenant-id")
    expect(script).toContain("--approved-by")
    expect(script).toContain("--change-ticket")
    expect(script).toContain("MICRO30_PROTECTED_APPLICATION_STATUSES")
    expect(script).toContain("PRODUCT_PRICING_UPDATED")
    expect(script).toContain("auditLog.create")
  })
})
