/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    commsSettings: { upsert: vi.fn(), update: vi.fn() },
  },
}))

import { getCommsSettings, updateCommsSettings } from "./settings"
import { prisma } from "@/lib/prisma"
import { isSealed, sealSecret } from "@/lib/crypto/secret-box"

beforeEach(() => vi.clearAllMocks())

describe("getCommsSettings", () => {
  it("atomically upserts the tenant's settings row", async () => {
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({ id: "c1", tenantId: "t1" } as any)
    const s = await getCommsSettings("t1")
    expect(s.id).toBe("c1")
    expect(prisma.commsSettings.upsert).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      create: { tenantId: "t1" },
      update: {},
    })
  })
})

describe("updateCommsSettings", () => {
  it("rejects an invalid waProvider", async () => {
    await expect(updateCommsSettings("t1", { waProvider: "PIGEON" })).rejects.toThrow(/invalid waProvider/)
  })

  it("updates allowed fields", async () => {
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({ id: "c1", tenantId: "t1" } as any)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ id: "c1", whatsappEnabled: true } as any)
    const s = await updateCommsSettings("t1", { whatsappEnabled: true })
    expect(s.whatsappEnabled).toBe(true)
    expect(prisma.commsSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" }, data: expect.objectContaining({ whatsappEnabled: true }) }),
    )
  })
})

describe("updateCommsSettings chatAlertEmail", () => {
  beforeEach(() => {
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({ id: "c1" } as any)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ id: "c1" } as any)
  })
  const written = () => vi.mocked(prisma.commsSettings.update).mock.calls[0][0].data

  it("stores a valid address, trimmed", async () => {
    await updateCommsSettings("t1", { chatAlertEmail: "  comms@acme-lending.example " })
    expect(written()).toMatchObject({ chatAlertEmail: "comms@acme-lending.example" })
  })

  it("stores an empty or blank string as null", async () => {
    await updateCommsSettings("t1", { chatAlertEmail: "  " })
    expect(written()).toMatchObject({ chatAlertEmail: null })
  })

  it("rejects an invalid address without writing", async () => {
    await expect(updateCommsSettings("t1", { chatAlertEmail: "not-an-email" })).rejects.toThrow(/invalid chatAlertEmail/)
    expect(prisma.commsSettings.update).not.toHaveBeenCalled()
  })

  it("rejects a non-string value as invalid, without writing", async () => {
    const patch = { chatAlertEmail: 42 } as unknown as { chatAlertEmail: string }
    await expect(updateCommsSettings("t1", patch)).rejects.toThrow(/invalid chatAlertEmail/)
    expect(prisma.commsSettings.update).not.toHaveBeenCalled()
  })

  it("leaves the column alone when the patch omits it", async () => {
    await updateCommsSettings("t1", { botsEnabled: true })
    expect(written()).not.toHaveProperty("chatAlertEmail")
  })
})

describe("updateCommsSettings WABA credentials", () => {
  beforeEach(() => vi.clearAllMocks())
  it("persists WABA credential fields when provided", async () => {
    process.env.WABA_ENC_KEY = Buffer.alloc(32, 7).toString("base64")
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({} as any)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ tenantId: "tn1" } as any)
    await updateCommsSettings("tn1", {
      waProvider: "WA_CLOUD",
      wabaPhoneNumberId: "PN1",
      wabaAccessToken: "TOK",
    })
    const arg = vi.mocked(prisma.commsSettings.update).mock.calls[0][0] as {
      data: { waProvider?: string; wabaPhoneNumberId?: string; wabaAccessToken?: string }
    }
    expect(arg.data.waProvider).toBe("WA_CLOUD")
    expect(arg.data.wabaPhoneNumberId).toBe("PN1")
    // the secret field is sealed before it hits the DB — never the raw value
    expect(isSealed(arg.data.wabaAccessToken as string)).toBe(true)
    delete process.env.WABA_ENC_KEY
  })
})

describe("updateCommsSettings seals secret WABA fields", () => {
  beforeEach(() => vi.clearAllMocks())

  it("stores wabaAccessToken sealed, not plaintext", async () => {
    process.env.WABA_ENC_KEY = Buffer.alloc(32, 7).toString("base64") // 32-byte key, no import needed
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({} as never)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ tenantId: "tn1" } as never)
    await updateCommsSettings("tn1", { wabaAccessToken: "EAAB-secret" })
    const arg = vi.mocked(prisma.commsSettings.update).mock.calls[0][0] as { data: { wabaAccessToken?: string } }
    expect(arg.data.wabaAccessToken).not.toBe("EAAB-secret")
    expect(isSealed(arg.data.wabaAccessToken as string)).toBe(true)
    delete process.env.WABA_ENC_KEY
  })

  it("seals all 3 secret WABA fields when a key is configured", async () => {
    process.env.WABA_ENC_KEY = Buffer.alloc(32, 7).toString("base64")
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({} as never)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ tenantId: "tn1" } as never)
    await updateCommsSettings("tn1", {
      wabaAccessToken: "EAAB-secret",
      wabaAppSecret: "app-secret-value",
      wabaVerifyToken: "my:custom:verify:token", // free-form, admin-chosen — may contain colons
    })
    const arg = vi.mocked(prisma.commsSettings.update).mock.calls[0][0] as {
      data: { wabaAccessToken?: string; wabaAppSecret?: string; wabaVerifyToken?: string }
    }
    expect(isSealed(arg.data.wabaAccessToken as string)).toBe(true)
    expect(isSealed(arg.data.wabaAppSecret as string)).toBe(true)
    expect(isSealed(arg.data.wabaVerifyToken as string)).toBe(true)
    delete process.env.WABA_ENC_KEY
  })

  it("FAIL-CLOSED: rejects storing a WABA secret when WABA_ENC_KEY is unset", async () => {
    delete process.env.WABA_ENC_KEY
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({} as never)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ tenantId: "tn1" } as never)
    await expect(updateCommsSettings("tn1", { wabaAccessToken: "x" })).rejects.toThrow(/WABA_ENC_KEY/)
  })

  it("does not double-seal an already-sealed value", async () => {
    const key = Buffer.alloc(32, 7).toString("base64")
    process.env.WABA_ENC_KEY = key
    const alreadySealed = sealSecret("x", key)
    vi.mocked(prisma.commsSettings.upsert).mockResolvedValue({} as never)
    vi.mocked(prisma.commsSettings.update).mockResolvedValue({ tenantId: "tn1" } as never)
    await updateCommsSettings("tn1", { wabaAccessToken: alreadySealed })
    const arg = vi.mocked(prisma.commsSettings.update).mock.calls[0][0] as { data: { wabaAccessToken?: string } }
    expect(arg.data.wabaAccessToken).toBe(alreadySealed)
    delete process.env.WABA_ENC_KEY
  })
})
