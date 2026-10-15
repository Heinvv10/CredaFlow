import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

type Handler = (req: NextRequest) => Response | Promise<Response>

async function proxyIn(mode: "staff" | "client" | "all"): Promise<Handler> {
  vi.stubEnv("APP_MODE", mode)
  vi.resetModules()
  const handler = (await import("./proxy")).default
  vi.unstubAllEnvs()
  return handler as unknown as Handler
}
const staffHost = await proxyIn("staff")
const clientHost = await proxyIn("client")
const singleHost = await proxyIn("all")

function visit(handler: Handler, pathname: string, method = "GET") {
  const req = new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: { authorization: "Bearer cfk_000000000000_x" },
  }) as NextRequest & { auth: unknown }
  req.auth = null
  return handler(req)
}

const API_PATHS = ["/api/v1/clients", "/api/v1/loans/loan-1/schedule", "/api/v1/openapi.json"]

describe("the lender API in the proxy", () => {
  // No session: the route's own bearer-key check is the gate (withApiKey).
  it.each(API_PATHS)("passes %s through to its handler without a session on the staff host", async (p) => {
    for (const handler of [staffHost, singleHost]) {
      const res = await visit(handler, p)
      expect(res.headers.get("x-middleware-next")).toBe("1")
    }
  })

  it("passes a POST through as well", async () => {
    const res = await visit(staffHost, "/api/v1/applications", "POST")
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it.each(API_PATHS)("does not serve %s on the client host", async (p) => {
    const res = await visit(clientHost, p)
    expect(res.status).toBe(404)
  })

  it("does not open a look-alike prefix", async () => {
    const res = await visit(staffHost, "/api/v10/clients")
    expect(res.status).toBe(401)
  })
})
