import { describe, expect, it } from "vitest"
import { parseConnectionInput } from "./connection-input"
import { testCertificatePem } from "./test-support/saml-fixture"

const domains = ["bank.example.test"]
const oidc = { protocol: "OIDC", enabled: true, allowedEmailDomains: domains, oidc: { issuer: "https://idp.example.test", clientId: "cid", clientSecret: "shh" } }
const saml = { protocol: "SAML", enabled: true, allowedEmailDomains: domains, saml: { entityId: "urn:cf:t1", idpEntityId: "https://idp.example.test/saml", idpSsoUrl: "https://idp.example.test/sso", idpCert: testCertificatePem() } }

describe("parseConnectionInput", () => {
  it("accepts a minimal OIDC connection and applies defaults", () => {
    const out = parseConnectionInput(oidc, null)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.value.oidcScopes).toEqual(["openid", "email", "profile"])
      expect(out.value.emailClaim).toBe("email")
      expect(out.value.groupsClaim).toBe("groups")
      expect(out.value.jitProvisioning).toBe(false)
      expect(out.clientSecret).toBe("shh")
    }
  })

  it("accepts a SAML connection, with an optional immutable subject attribute", () => {
    expect(parseConnectionInput(saml, null).ok).toBe(true)
    const withAttr = parseConnectionInput({ ...saml, saml: { ...saml.saml, subjectAttribute: "objectGUID" } }, null)
    expect(withAttr.ok && withAttr.value.samlSubjectAttribute).toBe("objectGUID")
    expect(parseConnectionInput({ ...saml, saml: { ...saml.saml, subjectAttribute: "bad name\n" } }, null).ok).toBe(false)
  })

  it("defaults the session to 10 hours and bounds it to 1..168", () => {
    const ok = parseConnectionInput(oidc, null)
    expect(ok.ok && ok.value.sessionHours).toBe(10)
    for (const hours of [0, 169, 1.5, "10", -1]) expect(parseConnectionInput({ ...oidc, sessionHours: hours }, null).ok).toBe(false)
    const week = parseConnectionInput({ ...oidc, sessionHours: 168 }, null)
    expect(week.ok && week.value.sessionHours).toBe(168)
  })

  it.each([
    ["an http issuer", { ...oidc, oidc: { ...oidc.oidc, issuer: "http://idp.example.test" } }],
    ["an issuer with credentials", { ...oidc, oidc: { ...oidc.oidc, issuer: "https://u:p@idp.example.test" } }],
    ["an issuer with a query", { ...oidc, oidc: { ...oidc.oidc, issuer: "https://idp.example.test/?x=1" } }],
    ["scopes without openid", { ...oidc, oidc: { ...oidc.oidc, scopes: ["email"] } }],
    ["no client secret on first save", { ...oidc, oidc: { issuer: oidc.oidc.issuer, clientId: "cid" } }],
    ["an http SAML SSO URL", { ...saml, saml: { ...saml.saml, idpSsoUrl: "http://idp.example.test/sso" } }],
    ["a SAML cert that is not a certificate", { ...saml, saml: { ...saml.saml, idpCert: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" } }],
    ["an unknown protocol", { ...oidc, protocol: "LDAP" }],
    ["a SUPER_ADMIN group mapping", { ...oidc, groupRoleMap: { g: "SUPER_ADMIN" } }],
    ["a SUPER_ADMIN JIT default", { ...oidc, jitProvisioning: true, jitDefaultRole: "SUPER_ADMIN" }],
    ["JIT with no default role", { ...oidc, jitProvisioning: true }],
    ["password login off while SSO is off", { ...oidc, enabled: false, passwordLoginDisabled: true }],
    ["a bad email domain", { ...oidc, allowedEmailDomains: ["not a domain"] }],
    ["enabling with no allowed email domains", { ...oidc, allowedEmailDomains: [] }],
    ["enabling with the domains left out", { protocol: "OIDC", enabled: true, oidc: oidc.oidc }],
    ["a non-boolean unverified-email opt-in", { ...oidc, allowUnverifiedEmail: "yes" }],
  ])("refuses %s", (_label, body) => {
    expect(parseConnectionInput(body, null).ok).toBe(false)
  })

  it("lets a connection be saved switched off without domains", () => {
    expect(parseConnectionInput({ ...oidc, enabled: false, allowedEmailDomains: [] }, null).ok).toBe(true)
  })

  it("defaults allowUnverifiedEmail to off and takes an explicit opt-in", () => {
    const off = parseConnectionInput(oidc, null)
    expect(off.ok && off.value.allowUnverifiedEmail).toBe(false)
    const on = parseConnectionInput({ ...oidc, allowUnverifiedEmail: true }, null)
    expect(on.ok && on.value.allowUnverifiedEmail).toBe(true)
  })

  it("keeps the stored OIDC secret when none is sent", () => {
    const existing = { protocol: "OIDC" as const, oidcClientSecretSealed: "enc:v1:x" }
    const out = parseConnectionInput({ ...oidc, oidc: { issuer: oidc.oidc.issuer, clientId: "cid" } }, existing)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.clientSecret).toBeNull()
  })

  it("lowercases email domains", () => {
    const out = parseConnectionInput({ ...oidc, allowedEmailDomains: ["Bank.Example.TEST"] }, null)
    expect(out.ok && out.value.allowedEmailDomains).toEqual(["bank.example.test"])
  })

  it("accepts several certificates for key rollover", () => {
    const two = `${testCertificatePem()}\n${testCertificatePem()}`
    expect(parseConnectionInput({ ...saml, saml: { ...saml.saml, idpCert: two } }, null).ok).toBe(true)
  })
})

