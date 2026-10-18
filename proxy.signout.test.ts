import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import type { NextAuthRequest } from "next-auth"
const { renewal, delay } = vi.hoisted(() => ({ renewal: vi.fn(), delay: { wait: undefined as Promise<void> | undefined } }))
// Model Auth.js handleAuth: it appends getSession's renewal cookie after the
// route's response. That must never accompany the logout handler's deletion.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: (req: NextAuthRequest) => Response) => async (req: NextAuthRequest) => {
  renewal();await delay.wait;const res = handler(Object.assign(req, { auth: null }));res.headers.append("set-cookie", "authjs.session-token=renewed; Path=/; HttpOnly");return res
} }))
import proxy from "./proxy"
const run = proxy as unknown as (req: NextAuthRequest) => Promise<Response> | Response
function request(path: string, method = "POST", origin = "https://localhost"): NextAuthRequest {
  return Object.assign(new NextRequest(`https://localhost${path}`, { method, headers: { host: "localhost", origin, "sec-fetch-site": origin === "https://localhost" ? "same-origin" : "cross-site" } }), { auth: null }) as NextAuthRequest
}
afterEach(() => { renewal.mockClear();delay.wait = undefined;vi.unstubAllEnvs() })
describe("proxy logout cookie ownership", () => {
  it.each(["logout-first", "prefetch-first"])("never restores a cookie when a deferred RSC response finishes %s", async order => {
    let release!: () => void
    delay.wait = new Promise<void>(resolve => { release = resolve })
    const req = request("/portal/statement", "GET")
    req.headers.set("rsc", "1")
    req.headers.set("next-router-prefetch", "1")
    const prefetched = run(req)
    expect(renewal).toHaveBeenCalledTimes(1)
    const cookieJar = new Map([["authjs.session-token", "original"]])
    const apply = (res: Response) => {
      for (const cookie of res.headers.getSetCookie()) {
        const [name, value] = cookie.split(";", 1)[0].split("=")
        if (value) cookieJar.set(name, value)
        else cookieJar.delete(name)
      }
    }
    const deletion = new Response(null, { headers: { "set-cookie": "authjs.session-token=; Path=/; Max-Age=0" } })
    if (order === "logout-first") apply(deletion)
    release()
    const response = await prefetched
    apply(response)
    if (order === "prefetch-first") apply(deletion)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(cookieJar.size).toBe(0)
    // The ordinary anonymous page guard still runs, even for RSC prefetches.
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toContain("/portal/login")
  })
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
