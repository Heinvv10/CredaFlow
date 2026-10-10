// app/api/portal/profile/route.test.ts
//
// Self-service profile updates from /portal/profile. Locks down the two
// identity-related foot-guns: the route MUST ignore body.clientId (IDOR)
// and body.email (auth-identity change without verification flow).

import { afterEach, describe, expect, it, vi } from "vitest"
import { PUT } from "./route"

const { findFirstClient, updateClient, logAudit, authMock } = vi.hoisted(() => ({
  findFirstClient: vi.fn(),
  updateClient: vi.fn().mockResolvedValue({}),
  logAudit: vi.fn().mockResolvedValue(undefined),
  authMock: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: findFirstClient, update: updateClient },
  },
}))

vi.mock("@/lib/auth", () => ({ auth: authMock }))

vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) =>
    fn({ id: "tenant-1" }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

async function callPut(body: unknown) {
  const req = new Request("http://localhost/api/portal/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return PUT(req)
}

function existingClient(overrides: Record<string, string | null> = {}) {
  return {
    id: "client-victim",
    phone: "0721234567",
    whatsapp: null,
    addressLine1: "1 Old Street",
    suburb: null,
    city: null,
    province: null,
    postalCode: null,
    ...overrides,
  }
}

describe("PUT /api/portal/profile", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when unauthenticated", async () => {
    authMock.mockResolvedValueOnce(null)
    const res = await callPut({ phone: "0820000222" })
    expect(res.status).toBe(401)
  })

  it("returns 400 for malformed JSON", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "c@x.co.za" } })
    const res = await callPut("{not-json")
    expect(res.status).toBe(400)
  })

  it("returns 400 when no editable fields are supplied", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "c@x.co.za" } })
    // clientId + email are NOT editable keys; should yield empty update.
    const res = await callPut({ clientId: "anything", email: "new@x.co.za" })
    expect(res.status).toBe(400)
    expect(findFirstClient).not.toHaveBeenCalled()
  })

  it("returns 400 when phone is blanked", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "c@x.co.za" } })
    const res = await callPut({ phone: "   " })
    expect(res.status).toBe(400)
  })

  it("returns 400 when phone is not a SA mobile number", async () => {
    // Joburg landline (011), foreign format, gibberish, too-short, and missing-leading-zero
    // all fail. Mock auth per iteration since mockResolvedValueOnce only covers one call.
    const bad = ["0111234567", "+15555555555", "AAAAAAAAAA", "082123", "27821234567"]
    for (const value of bad) {
      authMock.mockResolvedValueOnce({ user: { email: "c@x.co.za" } })
      const res = await callPut({ phone: value })
      expect(res.status, `phone "${value}" should be rejected`).toBe(400)
    }
    expect(updateClient).not.toHaveBeenCalled()
  })

  it("accepts +27 international mobile and the full 06x/07x/08x range", async () => {
    findFirstClient.mockResolvedValue(existingClient())
    // 0651234567 + 0699999999 guard against an accidental Telkom Mobile cutoff
    // if the regex ever tightens to e.g. ^0[7-8].
    for (const good of ["+27829999999", "0651234567", "0699999999", "0721111111", "0831234567"]) {
      authMock.mockResolvedValueOnce({ user: { email: "c@x.co.za" } })
      const res = await callPut({ phone: good })
      expect(res.status, `phone "${good}" should be accepted`).toBe(200)
      // The stored value matches the input verbatim (no mangling by normalize/trim).
      const payload = updateClient.mock.calls.at(-1)![0].data as Record<string, unknown>
      expect(payload.phone).toBe(good)
    }
  })

  it("returns 400 when whatsapp is not a SA mobile number", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "c@x.co.za" } })
    const res = await callPut({ whatsapp: "AAA" })
    expect(res.status).toBe(400)
    expect(updateClient).not.toHaveBeenCalled()
  })

  it("allows whatsapp to be cleared (empty string)", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "victim@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(existingClient({ whatsapp: "0821111111" }))
    const res = await callPut({ whatsapp: "" })
    expect(res.status).toBe(200)
    const payload = updateClient.mock.calls[0][0].data as Record<string, unknown>
    expect(payload.whatsapp).toBeNull()
  })

  it("returns 404 when no client matches the session email", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "ghost@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(null)
    const res = await callPut({ phone: "0820000222" })
    expect(res.status).toBe(404)
    expect(updateClient).not.toHaveBeenCalled()
  })

  it("ignores body.clientId — the row is resolved from session.user.email (IDOR guard)", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "victim@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(existingClient())
    const res = await callPut({
      clientId: "client-attacker", // attempted forgery
      phone: "0829999999",
    })
    expect(res.status).toBe(200)
    // findFirst was scoped to the session email, not the body's clientId.
    expect(findFirstClient).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: "victim@x.co.za" }),
      }),
    )
    // The update targets the victim's id, never the attacker's.
    expect(updateClient).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "client-victim" } }),
    )
    // Updated payload contains no clientId / email keys.
    const payload = updateClient.mock.calls[0][0].data as Record<string, unknown>
    expect(payload).not.toHaveProperty("clientId")
    expect(payload).not.toHaveProperty("email")
    expect(payload).not.toHaveProperty("id")
  })

  it("ignores body.email — email change is out of scope for portal self-service", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "victim@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(existingClient())
    await callPut({
      email: "hijacked@x.co.za",
      phone: "0829999999",
    })
    const payload = updateClient.mock.calls[0][0].data as Record<string, unknown>
    expect(payload).not.toHaveProperty("email")
    expect(payload.phone).toBe("0829999999")
  })

  it("writes only the diff to the DB and audit log — unchanged keys never reach prisma.update", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "victim@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(
      existingClient({ phone: "0721234567", city: "Pretoria" }),
    )
    const res = await callPut({
      phone: "0721234567", // unchanged
      city: "Johannesburg", // changed
      suburb: "Sandton", // added (was null)
    })
    expect(res.status).toBe(200)

    // The DB write must NOT include phone — it's unchanged. Writing it would
    // dirty-bump Client.updatedAt for a field that didn't move.
    const dbPayload = updateClient.mock.calls[0][0].data as Record<string, unknown>
    expect(dbPayload).toEqual({ city: "Johannesburg", suburb: "Sandton" })
    expect(dbPayload).not.toHaveProperty("phone")

    const audit = logAudit.mock.calls[0][0]
    expect(audit.oldValue).toEqual({ city: "Pretoria", suburb: null })
    expect(audit.newValue).toEqual({ city: "Johannesburg", suburb: "Sandton" })
    expect(audit.entity).toBe("Client")
    expect(audit.entityId).toBe("client-victim")
  })

  it("returns changed:false and skips audit when payload matches existing values", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "victim@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(
      existingClient({ phone: "0721234567", city: "Pretoria" }),
    )
    const res = await callPut({ phone: "0721234567", city: "Pretoria" })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { changed: boolean }
    expect(json.changed).toBe(false)
    expect(updateClient).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("treats empty string for nullable fields as null", async () => {
    authMock.mockResolvedValueOnce({ user: { email: "victim@x.co.za" } })
    findFirstClient.mockResolvedValueOnce(existingClient({ whatsapp: "0821111111" }))
    await callPut({ whatsapp: "" })
    const payload = updateClient.mock.calls[0][0].data as Record<string, unknown>
    expect(payload.whatsapp).toBeNull()
  })
})
