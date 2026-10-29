/**
 * Test-only: a throwaway identity provider key and certificate (made with the
 * openssl CLI at first use, never committed) and a builder for signed SAML
 * responses, so the negative cases (bad signature, expired, replayed, wrong
 * audience) run against real XML signatures.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SignedXml } from "xml-crypto"

export interface TestIdp { certPem: string; keyPem: string }

const cache = new Map<string, TestIdp>()

export function testIdp(name = "default"): TestIdp {
  const hit = cache.get(name)
  if (hit) return hit
  const dir = mkdtempSync(join(tmpdir(), "cf-saml-"))
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-subj", `/CN=test-idp-${name}`, "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
    ], { stdio: "ignore" })
    const idp = { certPem: readFileSync(join(dir, "c.pem"), "utf8"), keyPem: readFileSync(join(dir, "k.pem"), "utf8") }
    cache.set(name, idp)
    return idp
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const testCertificatePem = () => testIdp().certPem

export interface TestAssertion {
  idpEntityId?: string
  audience?: string
  destination?: string
  inResponseTo?: string
  nameId?: string
  /** NameID Format URI; default persistent. */
  nameIdFormat?: string
  attributes?: Record<string, string | string[]>
  authnContext?: string
  assertionId?: string
  notBefore?: Date
  notOnOrAfter?: Date
  /** Sign with this IdP's key instead of the default one (a forged signature). */
  signer?: TestIdp
  /** Sign the whole Response too (default: the Assertion only). */
  signResponse?: boolean
}

const iso = (d: Date) => d.toISOString()
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function sign(xml: string, idp: TestIdp, referenceId: string): string {
  const sig = new SignedXml({
    privateKey: idp.keyPem,
    publicCert: idp.certPem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  })
  sig.addReference({
    xpath: `//*[@ID='${referenceId}']`,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  })
  sig.computeSignature(xml, { location: { reference: `//*[@ID='${referenceId}']/*[local-name(.)='Issuer']`, action: "after" } })
  return sig.getSignedXml()
}

/** A base64 SAMLResponse as an identity provider would POST it. */
export function samlResponse(opts: TestAssertion = {}): string {
  const now = Date.now()
  const idp = opts.signer ?? testIdp()
  const issuer = opts.idpEntityId ?? "https://idp.example.test/saml"
  const audience = opts.audience ?? "urn:cf:t1"
  const destination = opts.destination ?? "https://app.example.test/api/auth/sso/saml/acs"
  const notBefore = opts.notBefore ?? new Date(now - 60_000)
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(now + 5 * 60_000)
  const assertionId = opts.assertionId ?? `_a${now}${Math.random().toString(16).slice(2)}`
  const responseId = `_r${now}${Math.random().toString(16).slice(2)}`
  const irt = opts.inResponseTo ? ` InResponseTo="${esc(opts.inResponseTo)}"` : ""
  const attrs = Object.entries(opts.attributes ?? {}).map(([name, v]) =>
    `<saml:Attribute Name="${esc(name)}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join("")}</saml:Attribute>`).join("")
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(new Date(now))}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${esc(opts.nameIdFormat ?? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent")}">${esc(opts.nameId ?? "staff@bank.example.test")}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${esc(destination)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(new Date(now))}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>${esc(opts.authnContext ?? "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport")}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : "") +
    `</saml:Assertion>`
  const signedAssertion = sign(assertion, idp, assertionId)
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${iso(new Date(now))}" Destination="${esc(destination)}"${irt}>` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signedAssertion + `</samlp:Response>`
  const out = opts.signResponse ? sign(response, idp, responseId) : response
  return Buffer.from(out, "utf8").toString("base64")
}
