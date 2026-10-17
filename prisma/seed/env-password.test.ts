import { describe, expect, it } from "vitest"
import { seedEnvPassword } from "./env-password"

describe("seedEnvPassword", () => {
  it("returns a policy-compliant value and undefined when unset", () => {
    expect(seedEnvPassword("SEED_X_PASSWORD", { SEED_X_PASSWORD: "synthetic-admin-pass-1" })).toBe("synthetic-admin-pass-1")
    expect(seedEnvPassword("SEED_X_PASSWORD", {})).toBeUndefined()
  })

  it("refuses a password the product would refuse", () => {
    expect(() => seedEnvPassword("SEED_X_PASSWORD", { SEED_X_PASSWORD: "password1" })).toThrow(/SEED_X_PASSWORD does not meet the password policy/)
  })
})
