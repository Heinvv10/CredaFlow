import { beforeEach, describe, expect, it } from "vitest"
import type { AuditPolicy } from "@prisma/client"
import { isSealed } from "@/lib/crypto/secret-box"
import { AuditPolicyError, buildPolicyWrite, policyView } from "./policy"

const publicHost = async () => [{ address: "8.8.8.8", family: 4 }]

beforeEach(() => {
  process.env.WABA_ENC_KEY = Buffer.alloc(32, 7).toString("base64")
})

describe("buildPolicyWrite", () => {
  it("keeps the 12-month retention floor and a 3-month hot window", async () => {
    await expect(buildPolicyWrite({ retentionMonths: 11 }, null)).rejects.toThrow(/retentionMonths must be a whole number from 12/)
    await expect(buildPolicyWrite({ hotMonths: 2 }, null)).rejects.toThrow(/hotMonths/)
    await expect(buildPolicyWrite({ retentionMonths: 12, hotMonths: 13 }, null)).rejects.toThrow(/cannot exceed/)
    await expect(buildPolicyWrite({ retentionMonths: 24, hotMonths: 6 }, null)).resolves.toMatchObject({ retentionMonths: 24, hotMonths: 6 })
  })

  it("needs a target before forwarding can be switched on", async () => {
    await expect(buildPolicyWrite({ siemEnabled: true, siemTransport: "SYSLOG_TLS" }, null, publicHost)).rejects.toThrow(/siemHost and siemPort/)
    await expect(buildPolicyWrite({ siemEnabled: true, siemTransport: "HTTPS_JSON" }, null, publicHost)).rejects.toThrow(/siemUrl/)
  })

  it("accepts https only, with no credentials in the URL", async () => {
    await expect(buildPolicyWrite({ siemUrl: "http://siem.example.invalid" }, null)).rejects.toThrow(/https/)
    await expect(buildPolicyWrite({ siemUrl: "https://u:p@siem.example.invalid" }, null)).rejects.toThrow(/credentials/)
  })

  it("refuses a host that resolves somewhere the deployment may not dial, without naming the address", async () => {
    const internal = async () => [{ address: "127.0.0.1", family: 4 }]
    const error = await buildPolicyWrite({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://siem.example.invalid/x" }, null, internal).catch((e) => e)
    expect(error).toBeInstanceOf(AuditPolicyError)
    expect(error.message).not.toContain("127.0.0.1")
  })

  it("seals the token and client key, and keeps a stored secret when none is sent", async () => {
    const first = await buildPolicyWrite({
      siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://siem.example.invalid/x", siemToken: "s3cret",
      siemClientCert: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----", siemClientKey: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----",
    }, null, publicHost)
    expect(isSealed(String(first.siemSealedToken))).toBe(true)
    expect(String(first.siemSealedToken)).not.toContain("s3cret")
    expect(isSealed(String(first.siemSealedKey))).toBe(true)

    const row = { ...first, id: "p1", tenantId: "t1", createdAt: new Date() } as unknown as AuditPolicy
    const second = await buildPolicyWrite({ retentionMonths: 18 }, row, publicHost)
    expect(second.siemSealedToken).toBe(first.siemSealedToken)
    const cleared = await buildPolicyWrite({ siemToken: null }, row, publicHost)
    expect(cleared.siemSealedToken).toBeNull()
  })

  it("requires a client certificate and its key together", async () => {
    await expect(buildPolicyWrite({ siemClientCert: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----" }, null)).rejects.toThrow(/go together/)
  })

  it("never returns a secret in the view", async () => {
    const data = await buildPolicyWrite({ siemToken: "s3cret" }, null)
    const view = policyView({ ...data, id: "p", tenantId: "t", createdAt: new Date() } as unknown as AuditPolicy)
    expect(JSON.stringify(view)).not.toContain("enc:v1")
    expect(view.siemTokenSet).toBe(true)
  })
})
