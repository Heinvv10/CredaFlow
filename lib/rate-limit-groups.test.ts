import { describe, expect, it } from "vitest"
import { classify, isAuthGroup, SEALABLE_GROUPS } from "./rate-limit-groups"

describe("rate-limit groups", () => {
  it("treats the paid-bureau submission counters as an authentication group that is never sealed", () => {
    expect(classify("", "portal:apply:c1")).toMatchObject({ group: "portal:apply:", failClosed: true })
    expect(isAuthGroup("portal:apply:")).toBe(true)
    expect(SEALABLE_GROUPS).not.toContain("portal:apply:")
  })

  it("never lets a flooded caller-keyed group share a group with a counter that matters", () => {
    const flooded = [classify("", "selfie-link:capture:tok:abc").group, classify("", "website:chat:start:phone:2771:1.2.3.4").group]
    const counters = ["portal:apply:c1", "statement-ai-ask:user:u1", "dealer-capture:t1:d1", "portal:af-sign:t1:c1", "website:contact:1.2.3.4"].map((k) => classify("", k).group)
    for (const group of flooded) expect(counters).not.toContain(group)
    expect(new Set([...flooded, ...counters]).size).toBe(flooded.length + counters.length - 0)
  })

  it("keeps address-gate groups out of the sealable ones", () => {
    for (const group of ["login:ip:", "forgot:ip:", "register:ip:", "reset-otp:", "sealed-new:", "portal-password-ip:"]) expect(SEALABLE_GROUPS).not.toContain(group)
  })
})
