import { beforeEach, describe, expect, it } from "vitest"
import type { AuditPolicy } from "@prisma/client"
import { isSealed } from "@/lib/crypto/secret-box"
import { AuditPolicyError, buildPolicyWrite, normaliseSiemUrl, policyView } from "./policy"

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

  it("normalises the SIEM URL and hands the database the origin and path flag WHATWG parsing gives", async () => {
    const data = await buildPolicyWrite({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "HTTPS://SIEM.Example.invalid:443/ingest/KEY?token=S" }, null, publicHost)
    expect(data).toMatchObject({ siemUrl: "https://siem.example.invalid/ingest/KEY?token=S", siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: true })
    expect(await buildPolicyWrite({ siemUrl: "https://siem.example.invalid" }, null, publicHost)).toMatchObject({ siemUrl: "https://siem.example.invalid/", siemUrlHasPathOrQuery: false })
  })

  it("refuses a URL a regex and a browser would read differently: backslash, tab, newline, other whitespace and control characters", () => {
    for (const url of [
      "https://siem.example\\@evil.invalid/x?token=S", "https://siem.example.invalid\\x?token=S", "https://siem.example.invalid/in\tgest?t=S",
      "https://siem.example.invalid/a\nb", "https://siem.example.invalid/a b", "https://siem.example.invalid/a\u0000b", "https://siem.example.invalid/a\u007fb", " https://siem.example.invalid/x\r",
    ]) expect(() => normaliseSiemUrl(url), JSON.stringify(url)).toThrow(AuditPolicyError)
    expect(() => normaliseSiemUrl("http://siem.example.invalid/x")).toThrow(/https/)
    expect(() => normaliseSiemUrl("https://u:p@siem.example.invalid/x")).toThrow(/credentials/)
    expect(() => normaliseSiemUrl("https://@siem.example.invalid/x")).not.toThrow()
  })

  it("requires a client certificate and its key together", async () => {
    await expect(buildPolicyWrite({ siemClientCert: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----" }, null)).rejects.toThrow(/go together/)
  })

  it("shows a URL as its origin and says whether a path or query is set, never the path or query", async () => {
    const view = (siemUrl: string | null) => policyView({ id: "p", tenantId: "t", createdAt: new Date(), siemUrl } as unknown as AuditPolicy)
    expect(view("https://siem.example.invalid/ingest/KEY123?token=abc")).toMatchObject({ siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: true })
    expect(view("https://siem.example.invalid")).toMatchObject({ siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: false })
    expect(view("https://siem.example.invalid:8443/")).toMatchObject({ siemOrigin: "https://siem.example.invalid:8443", siemUrlHasPathOrQuery: false })
    expect(view(null)).toMatchObject({ siemOrigin: null, siemUrlHasPathOrQuery: false })
    expect(JSON.stringify(view("https://siem.example.invalid/ingest/KEY123?token=abc"))).not.toMatch(/KEY123|token=abc/)
  })

  it("keeps the stored URL when the input does not change it", async () => {
    const row = { id: "p1", tenantId: "t1", retentionMonths: 12, hotMonths: 3, siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null,
      siemUrl: "https://siem.example.invalid/ingest/KEY123", siemSealedToken: null, siemCaCertPem: null, siemClientCert: null, siemSealedKey: null, createdAt: new Date() } as unknown as AuditPolicy
    expect((await buildPolicyWrite({ retentionMonths: 18 }, row, publicHost)).siemUrl).toBe("https://siem.example.invalid/ingest/KEY123")
  })

  it("never returns a secret in the view", async () => {
    const data = await buildPolicyWrite({ siemToken: "s3cret" }, null)
    const view = policyView({ ...data, id: "p", tenantId: "t", createdAt: new Date() } as unknown as AuditPolicy)
    expect(JSON.stringify(view)).not.toContain("enc:v1")
    expect(view.siemTokenSet).toBe(true)
  })
})
