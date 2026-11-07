import { describe, expect, it, vi } from "vitest"
import type { NextAuthRequest } from "next-auth"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

import proxy from "./proxy"

const run = proxy as unknown as (req: NextAuthRequest) => Promise<Response> | Response

// The lender's photos are public, like the site that shows them: an anonymous visitor on
// the public website host, and on the portal host, must get through to the route.
function visit(host: string, path: string, session: unknown = null) {
  const req = new NextRequest(`https://${host}${path}`, { method: "GET", headers: { host } })
  return run(Object.assign(req, { auth: session }) as unknown as NextAuthRequest)
}

describe("/api/website/imagery/*", () => {
  it.each([
    "/api/website/imagery/hero",
    "/api/website/imagery/hero?v=abcdef123456&w=800",
    "/api/website/imagery/product-personal?v=abcdef123456&w=1920",
    "/api/website/imagery/community",
  ])("lets an anonymous visitor through to %s", async (path) => {
    const res = await visit("acme.credaflow.example", path)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("is not a way past sign-in for the staff settings that write the images", async () => {
    const res = await visit("acme.credaflow.example", "/api/settings/website-imagery")
    expect(res.headers.get("x-middleware-next")).not.toBe("1")
    expect([401, 307, 308]).toContain(res.status)
  })
})
