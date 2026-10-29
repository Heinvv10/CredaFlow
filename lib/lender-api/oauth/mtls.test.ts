import { describe, expect, it } from "vitest"
import { X509Certificate } from "node:crypto"
import { checkClientCertificate } from "./mtls"
import { testIdp } from "@/lib/sso/test-support/saml-fixture"

const PEM = testIdp("mtls-client").certPem
const OTHER_PEM = testIdp("mtls-other").certPem
const fpOf = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase()
const FP = fpOf(PEM)
const DN = "CN=lpb-core,O=Lesotho PostBank,C=LS"
const on = { MTLS_TRUSTED_PROXY: "1" }
const client = (over = {}) => ({ requireMtls: true, mtlsSubjectDn: null as string | null, mtlsCertSha256: FP as string | null, ...over })
const headers = (h: Record<string, string>) => new Headers(h)
const good = { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-cert": encodeURIComponent(PEM) }

describe("checkClientCertificate", () => {
  it("does not look at headers for a client that does not require mTLS", () => {
    expect(checkClientCertificate(headers({}), client({ requireMtls: false }), {})).toBe("ok")
  })

  it("fails closed when the proxy is not declared trusted", () => {
    expect(checkClientCertificate(headers(good), client(), {})).toBe("not_trusted_proxy")
  })

  it("accepts a verified certificate whose SHA-256, computed by the app, is the pin (pin case and colons ignored)", () => {
    expect(checkClientCertificate(headers(good), client(), on)).toBe("ok")
    const colons = FP.toUpperCase().match(/../g)!.join(":")
    expect(checkClientCertificate(headers(good), client({ mtlsCertSha256: colons.replace(/:/g, "") }), on)).toBe("ok")
  })

  it("refuses when no certificate was presented or the proxy did not verify it", () => {
    expect(checkClientCertificate(headers({}), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-verify": "NONE" }), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-verify": "FAILED:unable to verify" }), client(), on)).toBe("no_cert")
  })

  it("refuses a different certificate", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": encodeURIComponent(OTHER_PEM) }), client(), on)).toBe("fingerprint_mismatch")
  })

  it("refuses a verified request that forwards no certificate, a garbage one, or an oversize one", () => {
    expect(checkClientCertificate(headers({ "x-ssl-client-verify": "SUCCESS" }), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": "not-a-cert" }), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": "%E0%A4%A" }), client(), on)).toBe("no_cert")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": "A".repeat(20_000) }), client(), on)).toBe("no_cert")
  })

  it("requires exactly one certificate and nothing else in the header", () => {
    const enc = encodeURIComponent
    const cases: Array<[string, string]> = [
      ["two headers joined by a comma (one appended by the caller)", `${enc(PEM)}, ${enc(OTHER_PEM)}`],
      ["the pinned certificate after a caller's certificate", `${enc(OTHER_PEM)}, ${enc(PEM)}`],
      ["two certificates in one value", enc(PEM + OTHER_PEM)],
      ["garbage before the certificate", enc("garbage\n" + PEM)],
      ["garbage after the certificate", enc(PEM + "garbage")],
      ["a certificate with text between its lines", enc(PEM.replace("\n", "\nsurprise\n"))],
    ]
    for (const [label, value] of cases) {
      expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": value }), client(), on), label).toBe("no_cert")
    }
  })

  it("accepts the certificate with or without its final newline", () => {
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": encodeURIComponent(PEM.trimEnd()) }), client(), on)).toBe("ok")
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-cert": encodeURIComponent(PEM.trimEnd() + "\n") }), client(), on)).toBe("ok")
  })

  it("ignores a fingerprint header: only the forwarded certificate counts, so a caller cannot assert one", () => {
    const h = headers({ "x-ssl-client-verify": "SUCCESS", "x-ssl-client-sha256": FP })
    expect(checkClientCertificate(h, client(), on)).toBe("no_cert")
  })

  it("a client that requires mTLS but has no fingerprint pin never passes, even with a matching DN", () => {
    const c = client({ mtlsCertSha256: null, mtlsSubjectDn: DN })
    expect(checkClientCertificate(headers({ ...good, "x-ssl-client-dn": DN }), c, on)).toBe("fingerprint_mismatch")
  })

  it("reads the header names the deployment configures", () => {
    const env = { ...on, MTLS_VERIFY_HEADER: "X-Cert-OK", MTLS_CERT_HEADER: "X-Cert-PEM" }
    expect(checkClientCertificate(headers({ "x-cert-ok": "SUCCESS", "x-cert-pem": encodeURIComponent(PEM) }), client(), env)).toBe("ok")
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
  it.each([
    ["a space after a comma", "CN=lpb-core, O=Lesotho PostBank,C=LS"],
    ["a doubled inner space", "CN=lpb-core,O=Lesotho  PostBank,C=LS"],
    ["a missing last RDN", "CN=lpb-core,O=Lesotho PostBank"],
    ["a one-character difference", "CN=lpb-core,O=Lesotho PostBanK,C=LS"],
    ["a trailing comma", `${DN},`],
    ["a quoted value", 'CN="lpb-core",O=Lesotho PostBank,C=LS'],
  ])("refuses a near-match subject: %s", (_l, dn) => {
    expect(checkClientCertificate(withDn(dn), pinned, on)).toBe("dn_mismatch")
  })

  it("refuses when the stored pin carries a stray space the header can never have (no trimming on our side)", () => {
    expect(checkClientCertificate(withDn(DN), client({ mtlsSubjectDn: `${DN} ` }), on)).toBe("dn_mismatch")
    expect(checkClientCertificate(withDn(DN), client({ mtlsSubjectDn: ` ${DN}` }), on)).toBe("dn_mismatch")
  })

  it("still needs the fingerprint when a subject is pinned too", () => {
    const h = headers({ "x-ssl-client-verify": "SUCCESS", "x-ssl-client-cert": encodeURIComponent(OTHER_PEM), "x-ssl-client-dn": DN })
    expect(checkClientCertificate(h, pinned, on)).toBe("fingerprint_mismatch")
  })
})
