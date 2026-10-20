import { afterEach, describe, expect, it, vi } from "vitest"
import { isWaEnvOff } from "./env-switch"

afterEach(() => {
  vi.unstubAllEnvs()
})

// The one WA_ENABLED parser, fail-closed. Unset and "true" (trimmed, any case)
// defer to the tenant's whatsappEnabled; EVERY other value is off. Cloud-only
// lenders never set it, so unset must not be off.
describe("isWaEnvOff", () => {
  it("is not off when unset - Cloud-only deployments never set WA_ENABLED", () => {
    vi.stubEnv("WA_ENABLED", undefined)
    expect(isWaEnvOff()).toBe(false)
  })

  it.each(["true", "TRUE", "True", " true ", "\ttrue\n"])("is not off for %j - defers to the tenant switch", (value) => {
    vi.stubEnv("WA_ENABLED", value)
    expect(isWaEnvOff()).toBe(false)
  })

  it.each(["false", "FALSE", " false ", "", " ", "   "])("is off for %j", (value) => {
    vi.stubEnv("WA_ENABLED", value)
    expect(isWaEnvOff()).toBe(true)
  })

  it.each(["1", "0", "off", "no", "yes", "on", "ture", "tru", "falsey", "true1", "enabled"])(
    "is off for the unrecognised value %j - a typo must not leave the kill switch open",
    (value) => {
      vi.stubEnv("WA_ENABLED", value)
      expect(isWaEnvOff()).toBe(true)
    },
  )
})
