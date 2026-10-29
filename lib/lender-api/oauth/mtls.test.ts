import { describe, expect, it } from "vitest"
import { checkClientCertificate, normaliseDn } from "./mtls"

const on = { MTLS_TRUSTED_PROXY: "1" } 
const client = (over = {}) => ({ requireMtls: true, mtlsSubjectDn: "CN=lpb-core,O=Lesotho PostBank,C=LS", mtlsCertSha256: null, ...over })
const headers = (h: Record<string, string>) => new Headers(h)
const good = { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-dn": "CN=lpb-core,O=Lesotho PostBank,C=LS" }

describe("checkClientCertificate", () => {
  it("does not look at headers for a client that does not require mTLS", () => {
    expect(checkClientCertificate(headers({}), client({ requireMtls: false }), {})).toBe("ok")
  })

  it("fails closed when the proxy is not declared trusted", () => {
    expect(checkClientCertificate(headers(good), client(), {})).toBe("not_trusted_proxy")
  })

  it("accepts a verified certificate with the pinned subject", () => {
    expect(checkClientCertificate(headers(good), client(), on)).toBe("ok")
  })

  it("accepts the same subject in OpenSSL slash form and another order", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-dn": "/C=LS/O=Lesotho PostBank/CN=lpb-core" }), client(), on)).toBe("ok")
  })

  it("refuses when no certificate was presented", () => {
    expect(checkClientCertificate(headers({}), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ "x-ssl-client-verify": "NONE" }), client(), on)).toBe("no_cert")
  })

  it("refuses a certificate the proxy did not verify", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-verify": "FAILED:unable to verify" }), client(), on)).toBe("no_cert")
  })

  it("refuses another subject", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-dn": "CN=someone-else,O=Lesotho PostBank,C=LS" }), client(), on)).toBe("dn_mismatch")
  })

  it("refuses a subject that merely contains the pinned one", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-dn": "CN=lpb-core,O=Lesotho PostBank,C=LS,OU=extra" }), client(), on)).toBe("dn_mismatch")
  })

  it("checks a pinned fingerprint", () => {
    const fp = "a".repeat(64)
    const c = client({ mtlsSubjectDn: null, mtlsCertSha256: fp })
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-sha256": fp.toUpperCase() }), c, on)).toBe("ok")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-sha256": "b".repeat(64) }), c, on)).toBe("fingerprint_mismatch")
    expect(checkClientCertificate(headers(good), c, on)).toBe("fingerprint_mismatch")
  })

  it("requires every pin that is set", () => {
    const c = client({ mtlsCertSha256: "a".repeat(64) })
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-sha256": "b".repeat(64) }), c, on)).toBe("fingerprint_mismatch")
  })

  it("reads the header names the deployment configures", () => {
    const env = { ...on, MTLS_VERIFY_HEADER: "X-Cert-OK", MTLS_DN_HEADER: "X-Cert-DN" } 
    expect(checkClientCertificate(headers({ "x-cert-ok": "SUCCESS", "x-cert-dn": "CN=lpb-core,O=Lesotho PostBank,C=LS" }), client(), env)).toBe("ok")
  })

  it("a client that requires mTLS but pins nothing never passes", () => {
    expect(checkClientCertificate(headers(good), client({ mtlsSubjectDn: null }), on)).toBe("dn_mismatch")
  })
})

describe("normaliseDn", () => {
  it("is case-insensitive on names and values and order-insensitive", () => {
    expect(normaliseDn("cn=A, o=B")).toEqual(normaliseDn("/O=b/CN=a"))
  })
  it("keeps escaped commas inside a value", () => {
    expect(normaliseDn("CN=Smith\\, John,O=Bank")).toEqual(["cn=smith, john", "o=bank"])
  })
})
