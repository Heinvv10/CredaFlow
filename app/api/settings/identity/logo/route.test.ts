import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { makePng } from "@/lib/config/__fixtures__/png"

const requireApiRoleMock = vi.fn()
const setLenderLogoMock = vi.fn()
const removeLenderLogoMock = vi.fn()
const getLenderLogoMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { marker: "prisma" } }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))
vi.mock("@/lib/config/lender-logo", () => ({
  LOGO_MAX_BYTES: 512 * 1024,
  setLenderLogo: (...args: unknown[]) => setLenderLogoMock(...args),
  removeLenderLogo: (...args: unknown[]) => removeLenderLogoMock(...args),
  getLenderLogo: (...args: unknown[]) => getLenderLogoMock(...args),
}))

import { DELETE, GET, POST } from "./route"

const URL = "https://app.example.test/api/settings/identity/logo"
const ADMIN = { user: { id: "admin-1", email: "admin@acme-lending.example", totpVerified: true } }
const post = (body: Uint8Array, headers: Record<string, string> = {}) => new NextRequest(URL, { method: "POST", body: new Uint8Array(body), headers })

describe("/api/settings/identity/logo", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue(ADMIN)
  })

  it("requires ADMIN to upload or remove, and any staff role to view", async () => {
    setLenderLogoMock.mockResolvedValue({ ok: true, changed: true, sha256: "a".repeat(64) })
    removeLenderLogoMock.mockResolvedValue({ ok: true, changed: true })
    await POST(post(makePng(10, 10)))
    await DELETE(new NextRequest(URL, { method: "DELETE" }))
    await GET(new NextRequest(URL))
    expect(requireApiRoleMock.mock.calls).toEqual([["ADMIN"], ["ADMIN"], ["READONLY"]])
  })

  it.each([false, undefined])("refuses an upload or removal from a session whose sign-in did not verify TOTP (%j)", async (totpVerified) => {
    requireApiRoleMock.mockResolvedValue({ user: { ...ADMIN.user, totpVerified } })
    expect((await POST(post(makePng(10, 10)))).status).toBe(403)
    expect((await DELETE(new NextRequest(URL, { method: "DELETE" }))).status).toBe(403)
    expect(setLenderLogoMock).not.toHaveBeenCalled()
    expect(removeLenderLogoMock).not.toHaveBeenCalled()
  })

  it("refuses when the role guard rejects, and stores nothing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) })
    expect((await POST(post(makePng(10, 10)))).status).toBe(403)
    expect((await GET(new NextRequest(URL))).status).toBe(403)
    expect(setLenderLogoMock).not.toHaveBeenCalled()
    expect(getLenderLogoMock).not.toHaveBeenCalled()
  })

  it("passes the raw bytes, tenant, actor and IP to the single write path", async () => {
    const png = makePng(10, 10)
    setLenderLogoMock.mockResolvedValue({ ok: true, changed: true, sha256: "a".repeat(64) })
    const res = await POST(post(png, { "content-type": "image/png" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true, sha256: "a".repeat(64) })
    const [db, args] = setLenderLogoMock.mock.calls[0]
    expect(db).toEqual({ marker: "prisma" })
    expect(args).toMatchObject({ tenantId: "tenant-1", actor: { id: "admin-1", email: "admin@acme-lending.example" }, ipAddress: "127.0.0.1" })
    expect(Buffer.from(args.bytes)).toEqual(png)
  })

  it("answers a validation refusal with 400 and its reason", async () => {
    setLenderLogoMock.mockResolvedValue({ ok: false, error: "The logo must be a PNG image." })
    const res = await POST(post(Buffer.from("not a png")))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "The logo must be a PNG image." })
  })

  it("refuses a body over the limit with 413 before the write path", async () => {
    const res = await POST(post(Buffer.alloc(512 * 1024 + 1)))
    expect(res.status).toBe(413)
    expect(setLenderLogoMock).not.toHaveBeenCalled()
  })

  // A chunked body declares no length; the cap must hold while reading it.
  it("refuses a streamed body over the limit with 413, without buffering it all", async () => {
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4 * 1024 * 1024) return controller.close()
        sent += 64 * 1024
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const req = new NextRequest(URL, { method: "POST", body, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1])
    expect(req.headers.get("content-length")).toBeNull()
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(2 * 1024 * 1024)
    expect(setLenderLogoMock).not.toHaveBeenCalled()
  })

  it("serves the logo as a PNG that the browser may not sniff or run", async () => {
    const png = makePng(10, 10)
    getLenderLogoMock.mockResolvedValue(new Uint8Array(png))
    const res = await GET(new NextRequest(URL))
    expect(res.status).toBe(200)
    expect(getLenderLogoMock).toHaveBeenCalledWith("tenant-1")
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(res.headers.get("cache-control")).toMatch(/^private/)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png)
  })

  it("answers 404 when there is no logo", async () => {
    getLenderLogoMock.mockResolvedValue(undefined)
    expect((await GET(new NextRequest(URL))).status).toBe(404)
  })
})
