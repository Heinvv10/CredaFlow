import { beforeEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const identity = vi.hoisted(() => ({ value: null as unknown }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => identity.value }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "tenant-1" }))
vi.mock("@/lib/public-loan-products-server", () => ({ getTenantPublicProductsServer: async () => [] }))
vi.mock("@/lib/seo/metadata", () => ({ siteUrl: () => "https://www.acme-lending.example" }))

import { GET } from "./route"

beforeEach(() => { identity.value = ACME_LENDER })

// §2a.2: no FSP number, no FSP line and no link to the insurance pages (they 404).
describe("llms.txt", () => {
  it("names the FSP number and the insurance page for a lender that holds one", async () => {
    const text = await (await GET()).text()
    expect(text).toContain("- FSP number: 12345\n")
    expect(text).toContain("/site/products/insurance")
  })

  it("names neither for a lender without an FSP number", async () => {
    identity.value = { ...ACME_LENDER, fspNumber: null }
    const text = await (await GET()).text()
    expect(text).not.toMatch(/FSP|insurance/i)
    expect(text).toContain("- NCR registration: NCRCP99999\n- Country: South Africa")
  })
})
