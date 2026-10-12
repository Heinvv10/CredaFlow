import { afterEach, describe, expect, it, vi } from "vitest"
import type { NextAuthRequest } from "next-auth"
import { NextRequest } from "next/server"

// auth(handler) normally returns a session-aware wrapper; return the handler
// itself so the real routing logic runs against a plain request.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

import proxy from "./proxy"

const run = proxy as unknown as (req: NextAuthRequest) => Promise<Response> | Response

function request(path: string): NextAuthRequest {
  const req = new NextRequest(`http://localhost${path}`, { headers: { host: "localhost" } })
  return Object.assign(req, { auth: null }) as unknown as NextAuthRequest
}

afterEach(() => vi.unstubAllEnvs())

describe("proxy X-Robots-Tag", () => {
  it.each(["/", "/login", "/dashboard", "/api/loans"])(
    "is set on %s when DEMO_MODE=true (public, redirect and 401 paths)",
    async (path) => {
      vi.stubEnv("DEMO_MODE", "true")
      const res = await run(request(path))
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow")
    },
  )

  it.each(["/", "/login", "/dashboard", "/api/loans"])("is absent on %s when DEMO_MODE is unset", async (path) => {
    vi.stubEnv("DEMO_MODE", "")
    const res = await run(request(path))
    expect(res.headers.has("X-Robots-Tag")).toBe(false)
  })
})
