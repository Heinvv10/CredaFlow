import { describe, expect, it, vi } from "vitest"

type Config = (typeof import("./auth-config"))["authBaseConfig"]

// The cookie names are fixed when the module loads (from AUTH_URL/NEXTAUTH_URL),
// so each URL needs its own copy of the module. Loaded here, not inside a test.
async function configFor(authUrl: string): Promise<Config> {
  vi.stubEnv("AUTH_URL", authUrl)
  vi.resetModules()
  const { authBaseConfig } = await import("./auth-config")
  vi.unstubAllEnvs()
  return authBaseConfig
}
const https = await configFor("https://acme.credaflow.example")
const http = await configFor("http://localhost:3000")

describe("session cookie", () => {
  // __Host- binds the cookie to the exact host: a sibling lender's subdomain
  // cannot set or overwrite it with Domain=, as it could a __Secure- cookie.
  it("is __Host- prefixed over https: Secure, Path=/, no Domain", () => {
    const { name, options } = https.cookies.sessionToken
    expect(name).toBe("__Host-authjs.session-token")
    expect(options.secure).toBe(true)
    expect(options.path).toBe("/")
    expect(options).not.toHaveProperty("domain")
  })

  it("keeps the unprefixed name over plain http (dev), where __Host- would be dropped", () => {
    const { name, options } = http.cookies.sessionToken
    expect(name).toBe("authjs.session-token")
    expect(options.secure).toBe(false)
  })
})
