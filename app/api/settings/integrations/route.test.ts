import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const queryRawMock = vi.fn()
const tenantConfigUpsertMock = vi.fn()
const auditLogCreateMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const staffTotpRequiredMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (tenant: { id: string }) => Promise<unknown>,
  ) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({
      $queryRaw: (query: unknown) => queryRawMock(query),
      tenantConfig: {
        upsert: (args: unknown) => tenantConfigUpsertMock(args),
        findUnique: (args: unknown) => tenantConfigFindUniqueMock(args),
      },
      auditLog: { create: (args: unknown) => auditLogCreateMock(args) },
    }),
  },
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))
const providerSwitchBlockersMock = vi.fn()
const auditRefusalMock = vi.fn()
vi.mock("@/lib/collections-engine/provider-switch", () => ({
  providerSwitchBlockers: (...args: unknown[]) => providerSwitchBlockersMock(...args),
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: (...args: unknown[]) => auditRefusalMock(...args) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: (t: string) => staffTotpRequiredMock(t) }))

import { randomBytes } from "node:crypto"
import { PATCH } from "./route"
import { openCredential } from "@/lib/integrations/tenant-credentials"

describe("PATCH /api/settings/integrations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    queryRawMock.mockResolvedValue([{ pg_advisory_xact_lock: null }])
    tenantConfigUpsertMock.mockResolvedValue({ tenantId: "tenant-1" })
    auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
    providerSwitchBlockersMock.mockResolvedValue(null)
    auditRefusalMock.mockResolvedValue(undefined)
    tenantConfigFindUniqueMock.mockResolvedValue(null)
    staffTotpRequiredMock.mockResolvedValue(false)
  })

  it("serializes a first TenantConfig insert with the lending policy lock", async () => {
    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collectionsEngineEnabled: true,
          collectionProvider: "netcash",
          avsProvider: "netcash",
        }),
      },
    ))

    expect(response.status).toBe(200)
    expect(queryRawMock).toHaveBeenCalledWith(expect.objectContaining({
      values: ["affordability-tenant-policy:tenant-1"],
    }))
    expect(tenantConfigUpsertMock).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      update: {
        collectionsEngineEnabled: true,
        collectionProvider: "netcash",
        avsProvider: "netcash",
      },
      create: {
        tenantId: "tenant-1",
        collectionsEngineEnabled: true,
        collectionProvider: "netcash",
        avsProvider: "netcash",
      },
    })
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      tenantConfigUpsertMock.mock.invocationCallOrder[0],
    )
    expect(tenantConfigUpsertMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreateMock.mock.invocationCallOrder[0],
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "INTEGRATION_SETTINGS_UPDATED",
        entityId: "tenant-1",
      }),
    })
  })

  it("fails closed when the mandatory integration-settings audit cannot be written", async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collectionsEngineEnabled: true }),
      },
    ))

    expect(response.status).toBe(500)
    expect(tenantConfigUpsertMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
  })

  it("refuses to change the collection provider while it still holds live mandates or open debits, and audits the refusal", async () => {
    providerSwitchBlockersMock.mockResolvedValue({ current: "netcash", mandates: 2, instructions: 1 })
    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionProvider: "simulated" }) },
    ))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/netcash still holds 2 live mandate.*1 open debit/)
    expect(providerSwitchBlockersMock).toHaveBeenCalledWith("tenant-1", "simulated")
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    expect(auditRefusalMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "COLLECTION_PROVIDER_CHANGE_REFUSED", entity: "TenantConfig", entityId: "tenant-1", tenantId: "tenant-1",
      userId: "admin-1", status: 409, detail: { current: "netcash", requested: "simulated", mandates: 2, instructions: 1 },
    }))
  })

  it("does not consult the collections engine when the provider is not being changed", async () => {
    await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionsEngineEnabled: true }) },
    ))
    expect(providerSwitchBlockersMock).not.toHaveBeenCalled()
  })

  // Both gates read the same requested provider: on a lender that requires
  // 2FA, a session without a verified code is refused either way, and nothing
  // is written.
  it("on a 2FA-required lender, refuses and audits a provider change while live mandates remain", async () => {
    staffTotpRequiredMock.mockResolvedValue(true)
    providerSwitchBlockersMock.mockResolvedValue({ current: "netcash", mandates: 1, instructions: 0 })
    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionProvider: "simulated" }) },
    ))
    expect(response.status).toBe(409)
    expect(providerSwitchBlockersMock).toHaveBeenCalledWith("tenant-1", "simulated")
    expect(auditRefusalMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "COLLECTION_PROVIDER_CHANGE_REFUSED", tenantId: "tenant-1", status: 409,
      detail: { current: "netcash", requested: "simulated", mandates: 1, instructions: 0 },
    }))
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  it("on a 2FA-required lender, a provider change with no live mandates still needs a verified sign-in", async () => {
    staffTotpRequiredMock.mockResolvedValue(true)
    const response = await PATCH(new NextRequest(
      "https://staging.acme-lending.example/api/settings/integrations",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionProvider: "simulated" }) },
    ))
    expect(response.status).toBe(403)
    expect(providerSwitchBlockersMock).toHaveBeenCalledWith("tenant-1", "simulated")
    expect(staffTotpRequiredMock).toHaveBeenCalledWith("tenant-1")
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  const patch = (body: Record<string, unknown>) => PATCH(new NextRequest(
    "https://staging.acme-lending.example/api/settings/integrations",
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ))

  it("seals every provider credential before it is stored, and audits the field names only", async () => {
    vi.stubEnv("WABA_ENC_KEY", randomBytes(32).toString("base64"))
    try {
      const response = await patch({ experianKey: "synthetic-user:synthetic-pass", stitchWebhookSecret: "synthetic-whsec" })
      expect(response.status).toBe(200)
      const { update } = tenantConfigUpsertMock.mock.calls[0][0] as { update: Record<string, string> }
      expect(update.experianKey.startsWith("enc:v1:")).toBe(true)
      expect(openCredential(update.experianKey)).toBe("synthetic-user:synthetic-pass")
      expect(openCredential(update.stitchWebhookSecret)).toBe("synthetic-whsec")
      const audit = JSON.stringify(auditLogCreateMock.mock.calls[0][0])
      expect(audit).toContain("experianKey")
      expect(audit).not.toContain("synthetic-pass")
      expect(audit).not.toContain("synthetic-whsec")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses a client-supplied sealed value rather than store ciphertext it did not seal", async () => {
    vi.stubEnv("WABA_ENC_KEY", randomBytes(32).toString("base64"))
    try {
      const response = await patch({ netcashKey: "enc:v1:forged:sealed:value" })
      expect(response.status).toBe(400)
      expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // Where Stitch pays the lender's receipts: redirecting it is redirecting
  // borrowers' money, so it takes a 2FA sign-in when the lender requires 2FA.
  it.each([
    ["the payee account", { stitchAccountNumber: "1234567890" }],
    ["the Stitch credentials", { stitchKey: "synthetic-client:synthetic-secret" }],
    ["the webhook secret", { stitchWebhookSecret: "synthetic-whsec" }],
    // Netcash pays out loans and collects debit orders: the same exposure.
    ["the Netcash payout key", { netcashKey: "synthetic-service-key" }],
    ["the Netcash debit-order key", { netcashDebitOrderKey: "synthetic-debit-key" }],
    ["the collection provider", { collectionProvider: "netcash" }],
    ["turning the collection provider off", { collectionProvider: null }],
  ])("refuses a change to %s without a TOTP-verified sign-in when the lender requires 2FA", async (_label, body) => {
    staffTotpRequiredMock.mockResolvedValue(true)
    const response = await patch(body)
    expect(response.status).toBe(403)
    expect(staffTotpRequiredMock).toHaveBeenCalledWith("tenant-1")
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  // The 2FA decision must be made on exactly what would be written: a value
  // the gate does not count must not be written either.
  it.each([
    ["a whitespace-only credential", { stitchKey: "   " }],
    ["a whitespace-padded webhook secret", { stitchWebhookSecret: " synthetic-whsec " }],
    ["a credential next to an unrelated change", { stitchKey: "synthetic-client:synthetic-secret", collectionsEngineEnabled: true }],
  ])("refuses %s without a TOTP-verified sign-in", async (_label, body) => {
    staffTotpRequiredMock.mockResolvedValue(true)
    vi.stubEnv("WABA_ENC_KEY", randomBytes(32).toString("base64"))
    try {
      expect((await patch(body)).status).toBe(403)
      expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ["a differently cased key", { StitchKey: "synthetic-client:synthetic-secret" }],
    ["a nested key", { stitch: { stitchKey: "synthetic-client:synthetic-secret" } }],
    ["a non-string value", { stitchAccountNumber: 1234567890 }],
    ["a null value", { stitchKey: null }],
    ["an empty string", { stitchWebhookSecret: "" }],
    ["a whitespace-only payee field", { stitchBankId: "   " }],
  ])("writes nothing for %s (the gate and the write agree it is no change)", async (_label, body) => {
    staffTotpRequiredMock.mockResolvedValue(true)
    const response = await patch(body)
    expect(response.status).toBe(400)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  it("does not read a credential from the prototype chain", async () => {
    staffTotpRequiredMock.mockResolvedValue(true)
    const response = await patch(JSON.parse('{"__proto__": {"stitchKey": "synthetic-client:synthetic-secret"}}'))
    expect(response.status).toBe(400)
    expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
  })

  it("audits the payee account old -> new, and no secret", async () => {
    staffTotpRequiredMock.mockResolvedValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test", totpVerified: true } })
    tenantConfigFindUniqueMock.mockResolvedValue({
      stitchBeneficiaryName: "Old Name", stitchBankId: "old-bank", stitchAccountNumber: "1111111111", stitchBranchCode: "111111",
    })
    vi.stubEnv("WABA_ENC_KEY", randomBytes(32).toString("base64"))
    try {
      const response = await patch({ stitchAccountNumber: "2222222222", stitchKey: "synthetic-client:synthetic-secret" })
      expect(response.status).toBe(200)
      const { data } = auditLogCreateMock.mock.calls[0][0] as { data: { oldValue: unknown; newValue: Record<string, unknown> } }
      expect(data.oldValue).toEqual({ stitchAccountNumber: "1111111111" })
      expect(data.newValue).toMatchObject({ stitchAccountNumber: "2222222222", updatedKeys: ["stitchAccountNumber", "stitchKey"] })
      expect(JSON.stringify(data)).not.toContain("synthetic-secret")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("refuses to store a credential in plaintext when no key is configured", async () => {
    vi.stubEnv("WABA_ENC_KEY", "")
    try {
      const response = await patch({ netcashKey: "synthetic-service-key" })
      expect(response.status).toBe(500)
      expect(tenantConfigUpsertMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
