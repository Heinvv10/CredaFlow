import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const transactionMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const tenantConfigUpsertMock = vi.fn()
const auditLogCreateMock = vi.fn()
const lockMock = vi.fn()
const totpRequiredMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: (args: unknown) => tenantConfigFindUniqueMock(args) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/affordability/evidence-locks", () => ({ lockAffordabilityTenantPolicy: (...a: unknown[]) => lockMock(...a) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: (id: string) => totpRequiredMock(id) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "203.0.113.7" }))

import { GET, PATCH } from "./route"
import { openBureauCredentials, sealBureauCredentials } from "@/lib/bureau/credentials"

const KEY = randomBytes(32).toString("base64")
const xds = { username: "synthetic-user", password: "synthetic-secret-pass", endpointUrl: "https://bureau.invalid" }
const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/settings/bureau", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))
const get = () => GET(new NextRequest("http://localhost/api/settings/bureau"))
let stored: { bureauProviderOrder: string[]; bureauMaxAgeDays: number; bureauCredentials: string | null } | null

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("WABA_ENC_KEY", KEY)
  stored = null
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@lender.test", totpVerified: true } })
  totpRequiredMock.mockResolvedValue(true)
  tenantConfigFindUniqueMock.mockImplementation(async () => stored)
  tenantConfigUpsertMock.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => {
    stored = { bureauProviderOrder: ["experian"], bureauMaxAgeDays: 60, bureauCredentials: null, ...stored, ...update } as typeof stored
    return stored
  })
  auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
    tenantConfig: { findUnique: tenantConfigFindUniqueMock, upsert: tenantConfigUpsertMock },
    auditLog: { create: auditLogCreateMock },
  }))
})
afterEach(() => vi.unstubAllEnvs())

describe("GET /api/settings/bureau", () => {
  it("is ADMIN-gated", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await get()).status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("ADMIN")
  })

  it("returns the defaults and says which bureaus have credentials, never the credentials", async () => {
    stored = { bureauProviderOrder: ["experian", "simulated"], bureauMaxAgeDays: 30, bureauCredentials: sealBureauCredentials({ xds }) }
    const body = await (await get()).json()
    expect(body).toMatchObject({ bureauProviderOrder: ["experian", "simulated"], bureauMaxAgeDays: 30, credentialsReadable: true })
    expect(body.providers.find((p: { id: string }) => p.id === "xds")).toMatchObject({
      credentialsConfigured: true, approvalBureau: false, implemented: false, credentialFields: ["username", "password", "endpointUrl"],
    })
    const text = JSON.stringify(body)
    expect(text).not.toContain("synthetic-secret-pass")
    expect(text).not.toContain("enc:v1:")
  })
})

describe("PATCH /api/settings/bureau", () => {
  it("saves the order and window, audited, under the tenant policy lock", async () => {
    const res = await patch({ bureauProviderOrder: ["Experian", "simulated", "xds"], bureauMaxAgeDays: 45 })
    expect(res.status).toBe(200)
    expect(lockMock).toHaveBeenCalledWith(expect.anything(), { tenantId: "tenant-1" })
    expect(tenantConfigUpsertMock.mock.calls[0][0].update).toEqual({ bureauProviderOrder: ["experian", "simulated", "xds"], bureauMaxAgeDays: 45 })
    expect(auditLogCreateMock.mock.calls[0][0].data).toMatchObject({
      action: "BUREAU_ENQUIRY_CONFIG_UPDATED", userId: "admin-1",
      oldValue: { bureauProviderOrder: ["experian"], bureauMaxAgeDays: 60 },
      newValue: { bureauProviderOrder: ["experian", "simulated", "xds"], bureauMaxAgeDays: 45 },
    })
  })

  it.each([
    [{ bureauProviderOrder: ["experian", "nobureau"] }, /Unknown bureau/],
    [{ bureauProviderOrder: ["xds", "experian"] }, /primary bureau must be one that can support an approval/],
    [{ bureauProviderOrder: ["experian", "experian"] }, /listed twice/],
    [{ bureauProviderOrder: [] }, /non-empty/],
    [{ bureauMaxAgeDays: 61 }, /1 to 60/],
    [{ bureauMaxAgeDays: 0 }, /1 to 60/],
    [{ bureauMaxAgeDays: 7.5 }, /1 to 60/],
    [{ credentials: { experian: { username: "x" } } }, /does not take stored credentials/],
    [{ credentials: { xds: { username: "x" } } }, /password is required/],
    [{ credentials: { xds: { ...xds, apiKey: "x" } } }, /unknown field/],
    [{ bureauCredentials: "enc:v1:forged" }, /Unknown setting/],
    [{}, /Nothing to update/],
  ])("refuses %j", async (body, error) => {
    const res = await patch(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(error)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("seals credentials on write and audits only which bureau changed", async () => {
    const res = await patch({ credentials: { xds } })
    expect(res.status).toBe(200)
    const sealed = tenantConfigUpsertMock.mock.calls[0][0].update.bureauCredentials as string
    expect(sealed.startsWith("enc:v1:")).toBe(true)
    expect(openBureauCredentials(sealed)).toEqual({ xds })
    const audit = JSON.stringify(auditLogCreateMock.mock.calls[0][0])
    expect(audit).not.toContain("synthetic-secret-pass")
    expect(auditLogCreateMock.mock.calls[0][0].data.newValue).toEqual({ credentialsSet: ["xds"], credentialsRemoved: [] })
    expect(JSON.stringify(await res.json())).not.toContain("synthetic-secret-pass")
  })

  it("keeps other bureaus' credentials when one changes, and stores null once the last is removed", async () => {
    stored = { bureauProviderOrder: ["experian"], bureauMaxAgeDays: 60, bureauCredentials: sealBureauCredentials({ xds, cpb: xds }) }
    await patch({ credentials: { xds: null } })
    expect(openBureauCredentials(stored!.bureauCredentials)).toEqual({ cpb: xds })
    await patch({ credentials: { cpb: null } })
    expect(stored!.bureauCredentials).toBeNull()
  })

  it("refuses to store credentials without the sealing key (503), writing nothing", async () => {
    vi.stubEnv("WABA_ENC_KEY", "")
    const res = await patch({ credentials: { xds } })
    expect(res.status).toBe(503)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  it("needs a TOTP-verified session when the lender requires staff 2FA", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@lender.test", totpVerified: false } })
    expect((await patch({ bureauMaxAgeDays: 30 })).status).toBe(403)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("follows the lender's policy when staff 2FA is off (demo stacks)", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@lender.test", totpVerified: false } })
    totpRequiredMock.mockResolvedValue(false)
    expect((await patch({ bureauMaxAgeDays: 30 })).status).toBe(200)
  })
})
