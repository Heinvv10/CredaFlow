import { describe, expect, it } from "vitest"
import { checkClientCertificate } from "./mtls"

const FP = "a".repeat(64)
const DN = "CN=lpb-core,O=Lesotho PostBank,C=LS"
const on = { MTLS_TRUSTED_PROXY: "1" }
const client = (over = {}) => ({ requireMtls: true, mtlsSubjectDn: null as string | null, mtlsCertSha256: FP as string | null, ...over })
const headers = (h: Record<string, string>) => new Headers(h)
const good = { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-sha256": FP }

describe("checkClientCertificate", () => {
  it("does not look at headers for a client that does not require mTLS", () => {
    expect(checkClientCertificate(headers({}), client({ requireMtls: false }), {})).toBe("ok")
  })

  it("fails closed when the proxy is not declared trusted", () => {
    expect(checkClientCertificate(headers(good), client(), {})).toBe("not_trusted_proxy")
  })

  it("accepts a verified certificate with the pinned fingerprint (case and colons ignored)", () => {
    expect(checkClientCertificate(headers(good), client(), on)).toBe("ok")
    const colons = FP.toUpperCase().match(/../g)!.join(":")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-sha256": colons }), client(), on)).toBe("ok")
  })

  it("refuses when no certificate was presented or the proxy did not verify it", () => {
    expect(checkClientCertificate(headers({}), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-verify": "NONE" }), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-verify": "FAILED:unable to verify" }), client(), on)).toBe("no_cert")
  })

  it("refuses another or missing fingerprint", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-sha256": "b".repeat(64) }), client(), on)).toBe("fingerprint_mismatch")
    expect(checkClientCertificate(headers({ "x-ssl-client-verify": "SUCCESS" }), client(), on)).toBe("fingerprint_mismatch")
  })

  it("a client that requires mTLS but has no fingerprint pin never passes, even with a matching DN", () => {
    const c = client({ mtlsCertSha256: null, mtlsSubjectDn: DN })
    expect(checkClientCertificate(headers({ "x-ssl-client-verify": "SUCCESS", "x-ssl-client-dn": DN }), c, on)).toBe("fingerprint_mismatch")
  })

  it("reads the header names the deployment configures", () => {
    const env = { ...on, MTLS_VERIFY_HEADER: "X-Cert-OK", MTLS_FINGERPRINT_HEADER: "X-Cert-FP" }
    expect(checkClientCertificate(headers({ "x-cert-ok": "SUCCESS", "x-cert-fp": FP }), client(), env)).toBe("ok")
  })
})

describe("the optional subject pin is an exact RFC 4514 string match", () => {
  const pinned = client({ mtlsSubjectDn: DN })
  const withDn = (dn: string | null) => headers({ ...good, ...(dn === null ? {} : { "x-ssl-client-dn": dn }) })

  it("accepts the identical string", () => expect(checkClientCertificate(withDn(DN), pinned, on)).toBe("ok"))
  it("refuses a missing subject", () => expect(checkClientCertificate(withDn(null), pinned, on)).toBe("dn_mismatch"))
  it("refuses reordered RDNs", () => expect(checkClientCertificate(withDn("O=Lesotho PostBank,CN=lpb-core,C=LS"), pinned, on)).toBe("dn_mismatch"))
  it("refuses the OpenSSL slash form", () => expect(checkClientCertificate(withDn("/C=LS/O=Lesotho PostBank/CN=lpb-core"), pinned, on)).toBe("dn_mismatch"))
  it("refuses a different case", () => expect(checkClientCertificate(withDn("cn=lpb-core,o=Lesotho PostBank,c=LS"), pinned, on)).toBe("dn_mismatch"))
  it("refuses a subject that merely contains the pinned one", () => expect(checkClientCertificate(withDn(`${DN},OU=extra`), pinned, on)).toBe("dn_mismatch"))
  it("refuses a multi-valued RDN where the pin has single-valued ones", () => {
    expect(checkClientCertificate(withDn("CN=lpb-core+O=Lesotho PostBank,C=LS"), pinned, on)).toBe("dn_mismatch")
  })
  it("matches a multi-valued RDN only when written identically", () => {
    const multi = "CN=lpb-core+UID=7,O=Bank,C=LS"
    expect(checkClientCertificate(withDn(multi), client({ mtlsSubjectDn: multi }), on)).toBe("ok")
    expect(checkClientCertificate(withDn("UID=7+CN=lpb-core,O=Bank,C=LS"), client({ mtlsSubjectDn: multi }), on)).toBe("dn_mismatch")
  })
  it("still needs the fingerprint when a subject is pinned too", () => {
    const h = headers({ "x-ssl-client-verify": "SUCCESS", "x-ssl-client-sha256": "b".repeat(64), "x-ssl-client-dn": DN })
    expect(checkClientCertificate(h, pinned, on)).toBe("fingerprint_mismatch")
  })
})
