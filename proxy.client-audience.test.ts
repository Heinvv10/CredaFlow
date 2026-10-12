import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// proxy.ts wraps its handler in the edge auth; with the wrapper as identity
// the default export IS the handler, and `req.auth` is the session it reads.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

type Handler = (req: NextRequest) => Response | Promise<Response>

// APP_MODE is read once at module load, so each audience needs its own copy of
// the module. Loaded here, not inside a test.
async function proxyIn(mode: "client" | "all"): Promise<Handler> {
  vi.stubEnv("APP_MODE", mode)
  vi.resetModules()
  const handler = (await import("./proxy")).default
  vi.unstubAllEnvs()
  return handler as unknown as Handler
}
const clientHost = await proxyIn("client")
const singleHost = await proxyIn("all")

const CLIENT = { user: { id: "client-1", role: "CLIENT", tenantId: "tenant-1" } }
const OFFICER = { user: { id: "user-1", role: "CREDIT_OFFICER", tenantId: "tenant-1" } }

function visit(handler: Handler, pathname: string, session: typeof CLIENT | null, method = "GET") {
  const req = new NextRequest(`http://localhost${pathname}`, { method }) as NextRequest & { auth: unknown }
  req.auth = session
  return handler(req)
}

const PACKET = "/api/applications/app-1/signing-packet"
// Staff-only routes beside it. The email one shares the packet's prefix.
const STAFF_SIBLINGS = [
  "/api/applications/app-1/signing-packet/email",
  "/api/applications/app-1/decide",
  "/api/applications/app-1/disburse",
  "/api/applications/app-1/agreement/countersign",
]

// The borrower's signing page frames, opens and downloads this URL. Refused
// here, the borrower is asked to sign a packet they cannot see.
describe("the signing packet on the client host (APP_MODE=client)", () => {
  it("lets a CLIENT session through to the route", async () => {
    const res = await visit(clientHost, PACKET, CLIENT)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("answers 401 without a session", async () => {
    const res = await visit(clientHost, PACKET, null)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  })

  it.each(STAFF_SIBLINGS)("keeps the staff-only sibling %s a 404", async (pathname) => {
    const res = await visit(clientHost, pathname, CLIENT)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  // Recording a returned signed packet (POST) is a staff action, and the
  // client host serves no staff actions.
  it("keeps a staff upload to the packet a 404", async () => {
    const res = await visit(clientHost, PACKET, OFFICER, "POST")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it.each(["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "answers a CLIENT %s to the packet with 404",
    async (method) => {
      const res = await visit(clientHost, PACKET, CLIENT, method)
      expect(res.status).toBe(404)
    },
  )
})

describe("the signing packet on a single host (APP_MODE=all)", () => {
  it("lets a CLIENT session through to the route", async () => {
    const res = await visit(singleHost, PACKET, CLIENT)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("answers 401 without a session", async () => {
    const res = await visit(singleHost, PACKET, null)
    expect(res.status).toBe(401)
  })

  it("lets staff upload a returned packet", async () => {
    const res = await visit(singleHost, PACKET, OFFICER, "POST")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("refuses a CLIENT session the upload", async () => {
    const res = await visit(singleHost, PACKET, CLIENT, "POST")
    expect(res.status).toBe(403)
  })

  it.each(STAFF_SIBLINGS)("refuses a CLIENT session the staff-only sibling %s", async (pathname) => {
    const res = await visit(singleHost, pathname, CLIENT)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })
})
