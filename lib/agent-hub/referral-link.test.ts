import { afterEach, describe, it, expect, vi } from "vitest"
import { buildReferralLink } from "./referral-link"

describe("buildReferralLink", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("points at the general apply page, not a product journey", () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://lender.example")
    expect(buildReferralLink("AGENTONE01"))
      .toBe("https://lender.example/site/apply?ref=AGENTONE01")
  })

  it("fails closed when the website origin is not configured", () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "")
    expect(() => buildReferralLink("X")).toThrow(/NEXT_PUBLIC_WEBSITE_URL/)
  })

  it("URL-encodes a code so a stray character cannot break the link", () => {
    expect(buildReferralLink("A B&C", "https://lender.example")).toContain("ref=A%20B%26C")
  })

  it("accepts an origin override for staging", () => {
    expect(buildReferralLink("X", "https://staging.lender.example"))
      .toBe("https://staging.lender.example/site/apply?ref=X")
  })

  it("refuses an empty code rather than emitting an unattributed link", () => {
    expect(() => buildReferralLink("  ", "https://lender.example")).toThrow(/code/i)
  })

  it("normalises a trailing slash in the origin so the path never doubles", () => {
    expect(buildReferralLink("X", "https://staging.lender.example/"))
      .toBe("https://staging.lender.example/site/apply?ref=X")
  })
})
