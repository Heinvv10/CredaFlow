import { describe, expect, it } from "vitest"
import { dealEvidenceUrl } from "./deal-evidence-url"

describe("dealEvidenceUrl", () => {
  it("uses the entity route for an entity lessee", () => {
    expect(dealEvidenceUrl({ dealId: "d1", entityId: "e1" }, "doc1")).toBe("/api/asset-finance/entities/e1/documents/doc1")
  })
  it("uses the deal route for an individual lessee (no entity)", () => {
    expect(dealEvidenceUrl({ dealId: "d1", entityId: null }, "doc1")).toBe("/api/asset-finance/deals/d1/documents/doc1")
  })
})
