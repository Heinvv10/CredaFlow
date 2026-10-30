import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { register } from "./instrumentation"

const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))

describe("RATE_LIMIT_STORE at boot", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("APP_MODE", "client")
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("stops the boot on a value that is neither memory nor postgres, naming the variable", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis")
    await expect(register()).rejects.toThrow(/RATE_LIMIT_STORE/)
  })

  it("boots with a valid value", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "memory")
    await expect(register()).resolves.toBeUndefined()
  })
})
