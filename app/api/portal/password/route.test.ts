import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { decode, encode } from "next-auth/jwt"

const { auth, findFirstClient, updateClient } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirstClient: vi.fn(),
  updateClient: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: findFirstClient, update: updateClient } } }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, handler: (t: { id: string }) => unknown) => handler({ id: "t1" }),
}))
vi.mock("@/lib/tenant-scope", () => ({ withoutTenantScope: <T,>(fn: () => Promise<T>) => fn() }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), AuditAction: { CLIENT_UPDATED: "CLIENT_UPDATED" } }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  callerIp: () => "203.0.113.7",
}))
vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn(async () => true), hash: vi.fn(async () => "$2a$12$new-hash-after-change") },
}))

import { POST } from "./route"
import { clientCredentialStamp, revalidateClientPrincipal } from "@/lib/client-session"

const SECRET = "route-test-secret"
const COOKIE = "authjs.session-token"
const OLD_HASH = "$2a$12$old-hash-before-change"
const NEW_HASH = "$2a$12$new-hash-after-change"

const sessionToken = (over: Record<string, unknown> = {}) => ({
  id: "c1", role: "CLIENT", tenantId: "t1", email: "client@example.test",
  credentialStamp: clientCredentialStamp(OLD_HASH), ...over,
})

async function change(token: Record<string, unknown> | null, body: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.cookie = `${COOKIE}=${await encode({ token, secret: SECRET, salt: COOKIE })}`
  const req = new NextRequest("http://localhost/api/portal/password", {
    method: "POST",
    headers,
    body: JSON.stringify({ currentPassword: "old-password", newPassword: "new-password-1", confirmPassword: "new-password-1", ...body }),
  })
  return POST(req)
}

async function reissuedToken(res: Response) {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`))
  if (!cookie) return null
  const value = cookie.split(";")[0].slice(COOKIE.length + 1)
  return decode({ token: value, secret: SECRET, salt: COOKIE })
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", SECRET)
  auth.mockReset().mockResolvedValue({ user: { id: "c1", email: "client@example.test", role: "CLIENT", tenantId: "t1" } })
  findFirstClient.mockReset().mockResolvedValue({ id: "c1", portalPassword: OLD_HASH })
  updateClient.mockReset().mockResolvedValue({})
})

describe("POST /api/portal/password keeps the changing session signed in", () => {
  it("re-issues the session cookie carrying the stamp of the NEW hash, claims unchanged", async () => {
    const res = await change(sessionToken())
    expect(res.status).toBe(200)
    expect(await reissuedToken(res)).toMatchObject({
      id: "c1", role: "CLIENT", tenantId: "t1", credentialStamp: clientCredentialStamp(NEW_HASH),
    })
  })

  it("the re-issued session survives revalidation and another session of the client ends", async () => {
    const res = await change(sessionToken())
    const fresh = await reissuedToken(res)
    // The database now holds the new hash.
    findFirstClient.mockResolvedValue({ id: "c1", portalPassword: NEW_HASH })
    expect(await revalidateClientPrincipal("c1", "t1", fresh!.credentialStamp)).toBe("valid")
    // A second browser still carries the stamp of the old hash.
    expect(await revalidateClientPrincipal("c1", "t1", clientCredentialStamp(OLD_HASH))).toBeNull()
  })

  it("derives the stamp from the stored hash, never from anything the caller sends", async () => {
    const res = await change(sessionToken(), { credentialStamp: "forged", stamp: "forged" })
    expect((await reissuedToken(res))!.credentialStamp).toBe(clientCredentialStamp(NEW_HASH))
  })

  it("does not mint a session from a request that carries none", async () => {
    const res = await change(null)
    expect(res.status).toBe(200)
    expect(await reissuedToken(res)).toBeNull()
  })

  it("does not re-issue a cookie that names a different client", async () => {
    const res = await change(sessionToken({ id: "someone-else" }))
    expect(await reissuedToken(res)).toBeNull()
  })

  it("does not re-issue a non-CLIENT cookie even if its id matches", async () => {
    const res = await change(sessionToken({ role: "ADMIN" }))
    expect(await reissuedToken(res)).toBeNull()
  })

  it("sets no cookie when the change is refused", async () => {
    const { default: bcrypt } = await import("bcryptjs")
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never)
    const res = await change(sessionToken())
    expect(res.status).toBe(400)
    expect(await reissuedToken(res)).toBeNull()
  })
})
