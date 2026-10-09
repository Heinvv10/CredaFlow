import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const clientFindFirstMock = vi.fn()
const clientFindUniqueMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/tenant-scope", () => ({
  // Runs the callback straight through. The real bypass is exercised in the
  // integration suite; here we only care that the route USES it for the
  // cross-tenant probe and never returns identity from it.
  withoutTenantScope: (fn: () => Promise<unknown>) => fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findFirst: (a: unknown) => clientFindFirstMock(a),
      findUnique: (a: unknown) => clientFindUniqueMock(a),
    },
  },
}))

import { GET } from "./route"
import { _resetRateLimitStore } from "@/lib/rate-limit"

// Genuinely Luhn-valid SA ID numbers — verified against isValidSaIdNumber,
// not eyeballed. Seed data is NOT a safe source for these: the seeded
// client 9307225000083 fails the checksum, so using it as a "valid" fixture
// asserts a 422 while looking like it asserts a 200.
const VALID_ID = "9307225000082"
const OTHER_ID = "8001015000086"

const request = (idNumber: string) =>
  new NextRequest(`http://x/api/clients/lookup?idNumber=${encodeURIComponent(idNumber)}`)

beforeEach(() => {
  vi.clearAllMocks()
  _resetRateLimitStore()
  requireApiRoleMock.mockResolvedValue({ user: { id: "officer-1", email: "officer@example.test" } })
  clientFindFirstMock.mockResolvedValue(null)
  clientFindUniqueMock.mockResolvedValue(null)
})

describe("GET /api/clients/lookup — authorization", () => {
  it("returns the guard's error and never queries when the role check fails", async () => {
    const denied = new Response("forbidden", { status: 403 })
    requireApiRoleMock.mockResolvedValue({ error: denied })

    const res = await GET(request(VALID_ID))

    expect(res.status).toBe(403)
    expect(clientFindFirstMock).not.toHaveBeenCalled()
    expect(clientFindUniqueMock).not.toHaveBeenCalled()
  })
})

describe("GET /api/clients/lookup — input validation", () => {
  it.each([
    ["empty", ""],
    ["too short", "930722500"],
    ["not a number", "abcdefghijklm"],
    ["13 digits but a bad checksum", "9307225000083"],
  ])("rejects %s without touching the database", async (_label, id) => {
    const res = await GET(request(id))

    expect(res.status).toBe(422)
    // The point of validating first: an attacker must supply a complete,
    // checksum-valid candidate, so partial IDs cannot be walked to narrow
    // down a date of birth.
    expect(clientFindFirstMock).not.toHaveBeenCalled()
    expect(clientFindUniqueMock).not.toHaveBeenCalled()
  })
})

describe("GET /api/clients/lookup — results", () => {
  it("names a client that belongs to the caller's tenant", async () => {
    clientFindFirstMock.mockResolvedValue({
      id: "c1",
      reference: "CLI-00042",
      firstName: "Themba",
      lastName: "Cele",
    })

    const res = await GET(request(VALID_ID))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      exists: true,
      sameTenant: true,
      client: { id: "c1", reference: "CLI-00042", firstName: "Themba", lastName: "Cele" },
    })
  })

  it("scopes the in-tenant lookup to the caller's tenant", async () => {
    await GET(request(VALID_ID))

    expect(clientFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", idNumber: VALID_ID } })
    )
  })

  it("reports a clash in another tenant WITHOUT identifying anyone", async () => {
    clientFindFirstMock.mockResolvedValue(null)
    clientFindUniqueMock.mockResolvedValue({ id: "someone-elses-client" })

    const res = await GET(request(OTHER_ID))

    expect(res.status).toBe(200)
    // The id came back from the database and must NOT reach the caller.
    expect(await res.json()).toEqual({ exists: true, sameTenant: false, client: null })
  })

  it("reports a free ID number", async () => {
    const res = await GET(request(VALID_ID))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false, sameTenant: false, client: null })
  })
})

describe("GET /api/clients/lookup — rate limiting", () => {
  it("stops a caller scripting unlimited existence probes", async () => {
    // Without a cap this endpoint is an existence oracle over every SA ID in
    // the system, restricted only by holding one CREDIT_OFFICER credential.
    const statuses: number[] = []
    for (let i = 0; i < 60; i++) {
      statuses.push((await GET(request(VALID_ID))).status)
    }

    expect(statuses).toContain(429)
  })

  it("keys the limit by user, so one officer cannot exhaust another's budget", async () => {
    // Deliberately NOT keyed by IP: staff share one office egress address, so
    // an IP key would put every credit officer in a single bucket and let
    // ordinary use lock the whole branch out.
    for (let i = 0; i < 40; i++) await GET(request(VALID_ID))
    expect((await GET(request(VALID_ID))).status).toBe(429)

    requireApiRoleMock.mockResolvedValue({ user: { id: "officer-2", email: "other@example.test" } })
    expect((await GET(request(VALID_ID))).status).toBe(200)
  })
})
