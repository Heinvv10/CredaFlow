import { describe, expect, it } from "vitest"
import { authBaseConfig } from "../auth-config"

const session = (token: Record<string, unknown>) =>
  authBaseConfig.callbacks.session({ session: { user: {} }, token } as never) as unknown as Promise<{ user: Record<string, unknown> }>

// The edge session (proxy.ts) is built from the cookie by this callback.
describe("edge session — totpEnrolmentRequired", () => {
  it("passes a boolean claim through, either way", async () => {
    expect((await session({ id: "u1", totpEnrolmentRequired: true })).user.totpEnrolmentRequired).toBe(true)
    expect((await session({ id: "u1", totpEnrolmentRequired: false })).user.totpEnrolmentRequired).toBe(false)
  })

  // Absent must stay distinguishable from false, or a token without the claim
  // would read as "not held" at the proxy.
  it.each([undefined, "true", 1, null])("leaves %j undefined, not false", async (value) => {
    expect((await session({ id: "u1", totpEnrolmentRequired: value })).user.totpEnrolmentRequired).toBeUndefined()
  })
})
