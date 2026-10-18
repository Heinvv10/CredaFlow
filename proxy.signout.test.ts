import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import type { NextAuthRequest } from "next-auth"
const { renewal } = vi.hoisted(() => ({ renewal: vi.fn() }))
// Model Auth.js handleAuth: it appends getSession's renewal cookie after the
// route's response. That must never accompany the logout handler's deletion.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: (req: NextAuthRequest) => Response) => (req: NextAuthRequest) => {
  renewal();const res = handler(Object.assign(req, { auth: null }));res.headers.append("set-cookie", "__Host-authjs.session-token=renewed; Path=/; Secure; HttpOnly");return res
} }))
import proxy from "./proxy"
const run = proxy as unknown as (req: NextAuthRequest) => Promise<Response> | Response
function request(path: string, method = "POST", origin = "https://localhost"): NextAuthRequest {
  return Object.assign(new NextRequest(`https://localhost${path}`, { method, headers: { host: "localhost", origin, "sec-fetch-site": origin === "https://localhost" ? "same-origin" : "cross-site" } }), { auth: null }) as NextAuthRequest
}
afterEach(() => { renewal.mockClear();vi.unstubAllEnvs() })
describe("proxy logout cookie ownership", () => {
  it("leaves the secure deletion cookie as the only session cookie on logout", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    const res = await run(request("/api/auth/signout"))
    // The authoritative Auth.js route then clears its own cookie normally.
    const downstream = new NextResponse(null, { headers: { "set-cookie": "__Host-authjs.session-token=; Path=/; Secure; Max-Age=0" } })
    const combined = [...res.headers.getSetCookie(), ...downstream.headers.getSetCookie()]
    expect(combined).toEqual(["__Host-authjs.session-token=; Path=/; Secure; Max-Age=0"])
    expect(renewal).not.toHaveBeenCalled()
    expect(res.headers.get("x-middleware-next")).toBe("1")
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow")
  })
  it("still refuses a cross-origin logout before the Auth.js handler", async () => {
    const res = await run(request("/api/auth/signout", "POST", "https://sibling.invalid"))
    expect(res.status).toBe(403);expect(renewal).not.toHaveBeenCalled()
  })
  it.each([["GET", "/api/auth/signout"], ["PUT", "/api/auth/signout"], ["POST", "/api/auth/signout/"], ["POST", "/api/auth/signout-extra"], ["GET", "/api/auth/session"], ["POST", "/api/auth/callback/credentials"]])("retains ordinary session enforcement for %s %s", async (method, path) => {
    await run(request(path, method));expect(renewal).toHaveBeenCalledTimes(1)
  })
})
