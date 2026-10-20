import { afterEach, describe, expect, it, vi } from "vitest"
import { isWaEnvOff } from "./env-switch"

afterEach(() => {
  vi.unstubAllEnvs()
})

// The one WA_ENABLED parser. Off only for exactly "false" (trimmed,
// case-insensitive) or empty; unset and everything else is NOT off and so
// defers to the tenant's whatsappEnabled. Cloud-only lenders never set it.
describe("isWaEnvOff", () => {
  it("is not off when unset - Cloud-only deployments never set WA_ENABLED", () => {
    vi.stubEnv("WA_ENABLED", undefined)
    expect(isWaEnvOff()).toBe(false)
  })

  it.each(["false", "FALSE", "False", " false ", "\tFalse\n"])("is off for %j", (value) => {
    vi.stubEnv("WA_ENABLED", value)
    expect(isWaEnvOff()).toBe(true)
  })

  it.each(["", " ", "   "])("is off for the empty / blank value %j", (value) => {
    vi.stubEnv("WA_ENABLED", value)
    expect(isWaEnvOff()).toBe(true)
  })

  it.each(["true", "TRUE", " true ", "1", "0", "off", "no", "ture", "falsey"])(
    "is not off for %j - any other value defers to the tenant switch",
    (value) => {
      vi.stubEnv("WA_ENABLED", value)
      expect(isWaEnvOff()).toBe(false)
    },
  )
})
