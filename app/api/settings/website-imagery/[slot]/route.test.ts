import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeJpeg } from "@/lib/config/__fixtures__/images"

const requireApiRoleMock = vi.fn()
const setMock = vi.fn()
const updateTextMock = vi.fn()
const removeMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { marker: "prisma" } }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))
vi.mock("@/lib/config/website-imagery", () => ({
  setWebsiteImage: (...args: unknown[]) => setMock(...args),
  updateWebsiteImageText: (...args: unknown[]) => updateTextMock(...args),
  removeWebsiteImage: (...args: unknown[]) => removeMock(...args),
}))

import { DELETE, PATCH, PUT } from "./route"

const url = (slot: string) => `https://app.example.test/api/settings/website-imagery/${slot}`
const ctx = (slot: string) => ({ params: Promise.resolve({ slot }) })
const ADMIN = { user: { id: "admin-1", email: "admin@acme-lending.example", totpVerified: true } }

function put(slot: string, fields: Record<string, string | Blob>) {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) form.set(name, value)
  return new NextRequest(url(slot), { method: "PUT", body: form })
}
const jpegBlob = (bytes = makeJpeg(100, 100)) => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" })
const patch = (slot: string, body: unknown) => new NextRequest(url(slot), { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
const del = (slot: string) => new NextRequest(url(slot), { method: "DELETE" })

describe("/api/settings/website-imagery/[slot]", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue(ADMIN)
  })

  it("requires ADMIN for every write", async () => {
    setMock.mockResolvedValue({ ok: true, changed: true })
    updateTextMock.mockResolvedValue({ ok: true, changed: true })
    removeMock.mockResolvedValue({ ok: true, changed: true })
    await PUT(put("hero", { file: jpegBlob(), alt: "x" }), ctx("hero"))
    await PATCH(patch("hero", { alt: "x" }), ctx("hero"))
    await DELETE(del("hero"), ctx("hero"))
    expect(requireApiRoleMock.mock.calls).toEqual([["ADMIN"], ["ADMIN"], ["ADMIN"]])
  })

  it("refuses a non-admin on every write and stores nothing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) })
    expect((await PUT(put("hero", { file: jpegBlob(), alt: "x" }), ctx("hero"))).status).toBe(403)
    expect((await PATCH(patch("hero", { alt: "x" }), ctx("hero"))).status).toBe(403)
    expect((await DELETE(del("hero"), ctx("hero"))).status).toBe(403)
    expect(setMock).not.toHaveBeenCalled()
    expect(updateTextMock).not.toHaveBeenCalled()
    expect(removeMock).not.toHaveBeenCalled()
  })

  it.each([false, undefined])("refuses a session whose sign-in did not verify TOTP (%j)", async (totpVerified) => {
    requireApiRoleMock.mockResolvedValue({ user: { ...ADMIN.user, totpVerified } })
    expect((await PUT(put("hero", { file: jpegBlob(), alt: "x" }), ctx("hero"))).status).toBe(403)
    expect((await PATCH(patch("hero", { alt: "x" }), ctx("hero"))).status).toBe(403)
    expect((await DELETE(del("hero"), ctx("hero"))).status).toBe(403)
    expect(setMock).not.toHaveBeenCalled()
    expect(removeMock).not.toHaveBeenCalled()
  })

  it("passes the file, alt text, tenant, actor and IP to the single write path", async () => {
    const jpeg = makeJpeg(1600, 900)
    setMock.mockResolvedValue({ ok: true, changed: true, sha256: "a".repeat(64) })
    const res = await PUT(put("product-personal", { file: jpegBlob(jpeg), alt: "A card" }), ctx("product-personal"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true, sha256: "a".repeat(64) })
    const [db, args] = setMock.mock.calls[0]
    expect(db).toEqual({ marker: "prisma" })
    expect(args).toMatchObject({ tenantId: "tenant-1", slot: "product-personal", actor: { id: "admin-1", email: "admin@acme-lending.example" }, ipAddress: "127.0.0.1", text: { alt: "A card" } })
    expect(Buffer.from(args.bytes)).toEqual(jpeg)
  })

  it("takes the tenant from the session's host, never from the request body", async () => {
    setMock.mockResolvedValue({ ok: true, changed: true, sha256: "a".repeat(64) })
    await PUT(put("hero", { file: jpegBlob(), alt: "x", tenantId: "tenant-2" }), ctx("hero"))
    expect(setMock.mock.calls[0][1].tenantId).toBe("tenant-1")
    expect(setMock.mock.calls[0][1].text).not.toHaveProperty("tenantId")
    await PATCH(patch("hero", { alt: "x", tenantId: "tenant-2" }), ctx("hero"))
    expect(updateTextMock.mock.calls[0][1].tenantId).toBe("tenant-1")
    await DELETE(del("hero"), ctx("hero"))
    expect(removeMock.mock.calls[0][1].tenantId).toBe("tenant-1")
  })

  it("sends the community heading and sentence along with the alt text", async () => {
    setMock.mockResolvedValue({ ok: true, changed: true, sha256: "a".repeat(64) })
    await PUT(put("community", { file: jpegBlob(), alt: "Street", heading: "Our street", body: "We live here." }), ctx("community"))
    expect(setMock.mock.calls[0][1].text).toEqual({ alt: "Street", heading: "Our street", body: "We live here." })
  })

  it("answers a validation refusal with 400 and its reason", async () => {
    setMock.mockResolvedValue({ ok: false, error: "The image must be a JPEG, PNG or WebP file." })
    const res = await PUT(put("hero", { file: new Blob(["GIF89a"]), alt: "x" }), ctx("hero"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "The image must be a JPEG, PNG or WebP file." })
  })

  it("refuses an oversize body with 413, by its declared length and when no length is declared, and stores nothing", async () => {
    const big = new Blob([new Uint8Array(3 * 1024 * 1024 + 70 * 1024)])
    const declared = put("hero", { file: big, alt: "x" })
    expect((await PUT(declared, ctx("hero"))).status).toBe(413)

    const form = new FormData()
    form.set("file", big)
    form.set("alt", "x")
    const multipart = new Request("https://app.example.test/x", { method: "POST", body: form })
    const chunked = new NextRequest(url("hero"), {
      method: "PUT",
      headers: { "content-type": multipart.headers.get("content-type") ?? "" },
      body: new ReadableStream({ start(controller) { void multipart.arrayBuffer().then((b) => { controller.enqueue(new Uint8Array(b)); controller.close() }) } }),
      duplex: "half",
    })
    chunked.headers.delete("content-length")
    expect((await PUT(chunked, ctx("hero"))).status).toBe(413)
    expect(setMock).not.toHaveBeenCalled()
  })

  it("refuses a body that is not multipart, and a request with no file", async () => {
    const notForm = new NextRequest(url("hero"), { method: "PUT", body: "raw", headers: { "content-type": "text/plain" } })
    expect((await PUT(notForm, ctx("hero"))).status).toBe(400)
    expect((await PUT(put("hero", { alt: "x" }), ctx("hero"))).status).toBe(400)
    expect(setMock).not.toHaveBeenCalled()
  })

  it("404s a slot it does not know, before authorising a write to it", async () => {
    expect((await PUT(put("banner", { file: jpegBlob(), alt: "x" }), ctx("banner"))).status).toBe(404)
    expect((await PUT(put("../hero", { file: jpegBlob(), alt: "x" }), ctx("../hero"))).status).toBe(404)
    expect((await PATCH(patch("product-mortgage", { alt: "x" }), ctx("product-mortgage"))).status).toBe(404)
    expect((await DELETE(del("banner"), ctx("banner"))).status).toBe(404)
    expect(setMock).not.toHaveBeenCalled()
    expect(removeMock).not.toHaveBeenCalled()
  })

  it("PATCH edits text; a refusal is a 400 and bad JSON is a 400", async () => {
    updateTextMock.mockResolvedValue({ ok: false, error: "There is no image in that slot yet; upload one first." })
    expect((await PATCH(patch("hero", { alt: "x" }), ctx("hero"))).status).toBe(400)
    expect((await PATCH(new NextRequest(url("hero"), { method: "PATCH", body: "{" }), ctx("hero"))).status).toBe(400)
  })

  it("answers 500, not the error, when storing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    setMock.mockRejectedValue(new Error("EACCES: /app/uploads"))
    const res = await PUT(put("hero", { file: jpegBlob(), alt: "x" }), ctx("hero"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("EACCES")
  })
})
