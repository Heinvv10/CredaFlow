import { afterEach, describe, expect, it, vi } from "vitest"
import { authBaseConfig } from "./auth-config"

// The edge proxy decodes the cookie with this config's jwt callback alone, so it
// has to apply the same host-audience rule as lib/auth.ts: a token of the other
// audience is no session at all, whatever secret signed it.
const jwt = authBaseConfig.callbacks.jwt as (args: { token: Record<string, unknown> }) => Promise<unknown>

afterEach(() => vi.unstubAllEnvs())

describe("edge jwt callback host audience", () => {
  const staff = { id: "u1", role: "LOAN_ADMIN", tenantId: "t1" }
  const client = { id: "c1", role: "CLIENT", tenantId: "t1" }

  it("APP_MODE=client: a staff token is no session, a CLIENT token is kept", async () => {
    vi.stubEnv("APP_MODE", "client")
    expect(await jwt({ token: staff })).toBeNull()
    expect(await jwt({ token: client })).toEqual(client)
  })

  it("APP_MODE=staff: a CLIENT token is no session, a staff token is kept", async () => {
    vi.stubEnv("APP_MODE", "staff")
    expect(await jwt({ token: client })).toBeNull()
    expect(await jwt({ token: staff })).toEqual(staff)
  })

  it("APP_MODE=all keeps both", async () => {
    vi.stubEnv("APP_MODE", "all")
    expect(await jwt({ token: staff })).toEqual(staff)
    expect(await jwt({ token: client })).toEqual(client)
  })

  it("a DEALER token: never on the client host; kept on the staff container, which runs the dealer host", async () => {
    const dealer = { id: "du1", role: "DEALER", tenantId: "t1", dealerId: "d1" }
    vi.stubEnv("APP_MODE", "client")
    expect(await jwt({ token: dealer })).toBeNull()
    vi.stubEnv("APP_MODE", "staff")
    expect(await jwt({ token: dealer })).toEqual(dealer)
  })
})
