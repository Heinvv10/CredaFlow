import { beforeEach, describe, expect, it, vi } from "vitest"

const cacheRows = vi.hoisted(() => new Map<string, { value: string; expiresAt: Date }>())
vi.mock("@/lib/prisma", () => ({
  prisma: {
    ssoCacheEntry: {
      create: async ({ data }: { data: { key: string; value: string; expiresAt: Date } }) => {
        if (cacheRows.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" })
        cacheRows.set(data.key, { value: data.value, expiresAt: data.expiresAt })
      },
      findUnique: async ({ where }: { where: { key: string } }) => {
        const r = cacheRows.get(where.key)
        return r ? { key: where.key, ...r } : null
      },
      deleteMany: async ({ where }: { where: { key?: string; expiresAt?: { lt: Date } } }) => {
        let count = 0
        for (const [key, row] of [...cacheRows]) {
          if ((where.key === undefined || key === where.key) && (!where.expiresAt || row.expiresAt < where.expiresAt.lt)) { cacheRows.delete(key); count++ }
        }
        return { count }
      },
    },
  },
}))

import { beginSaml, completeSaml, SamlFlowError } from "./saml"
import { readState } from "./tokens"
import { samlResponse, testIdp } from "./test-support/saml-fixture"
import type { LoadedConnection } from "./connection"

const ACS = "https://app.example.test/api/auth/sso/saml/acs"
const IDP_ID = "https://idp.example.test/saml"
const conn = (over: Partial<LoadedConnection> = {}) => ({
  tenantId: "t1", protocol: "SAML", enabled: true, samlEntityId: "urn:cf:t1", samlIdpEntityId: IDP_ID,
  samlIdpSsoUrl: "https://idp.example.test/sso", samlIdpCert: testIdp().certPem, emailClaim: "email", groupsClaim: "groups", mfaAcrValues: [], ...over,
}) as LoadedConnection

/** Begin a login so the request id is on record, as the browser leaving for the IdP would. */
async function begin(c = conn()) {
  const { url, stateToken } = await beginSaml(c, { acsUrl: ACS, returnTo: "/dashboard" })
  const requestXml = await inflate(new URL(url).searchParams.get("SAMLRequest")!)
  const requestId = /ID="([^"]+)"/.exec(requestXml)![1]
  return { url, flow: (await readState(stateToken))!, requestId, relay: new URL(url).searchParams.get("RelayState")! }
}

import { inflateRaw } from "node:zlib"
const inflate = (b64: string) => new Promise<string>((ok, bad) => inflateRaw(Buffer.from(b64, "base64"), (e, r) => (e ? bad(e) : ok(r.toString("utf8")))))

const attrs = { email: "ann@bank.example.test", groups: ["admins", "staff"] }
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as SamlFlowError | null

beforeEach(() => {
  cacheRows.clear()
  process.env.AUTH_SECRET = "s".repeat(48)
})

describe("SAML sign-in", () => {
  it("sends an AuthnRequest naming our entity id and ACS, with the relay state", async () => {
    const { url, requestId, relay } = await begin()
    expect(url.startsWith("https://idp.example.test/sso?")).toBe(true)
    expect(requestId).toMatch(/^_/)
    expect(relay).toBeTruthy()
  })

  it("accepts a correctly signed assertion and reads email, groups and MFA", async () => {
    const { flow, requestId, relay } = await begin()
    const who = await completeSaml(conn(), {
      acsUrl: ACS, flow, relayState: relay,
      samlResponse: samlResponse({ inResponseTo: requestId, attributes: attrs, authnContext: "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract" }),
    })
    expect(who).toMatchObject({ email: "ann@bank.example.test", groups: ["admins", "staff"], mfaProven: true, subject: `${IDP_ID}|staff@bank.example.test` })
  })

  it("falls back to an email NameID and reports no MFA for password-only", async () => {
    const { flow, requestId, relay } = await begin()
    const who = await completeSaml(conn(), { acsUrl: ACS, flow, relayState: relay, samlResponse: samlResponse({ inResponseTo: requestId, nameId: "bob@bank.example.test" }) })
    expect(who).toMatchObject({ email: "bob@bank.example.test", groups: [], mfaProven: false })
  })

  it("accepts a response signed on the Response element too", async () => {
    const { flow, requestId, relay } = await begin()
    const who = await completeSaml(conn(), { acsUrl: ACS, flow, relayState: relay, samlResponse: samlResponse({ inResponseTo: requestId, attributes: attrs, signResponse: true }) })
    expect(who.email).toBe("ann@bank.example.test")
  })

  it("honours a lender's own MFA context", async () => {
    const { flow, requestId, relay } = await begin(conn({ mfaAcrValues: ["urn:bank:strong"] }))
    const who = await completeSaml(conn({ mfaAcrValues: ["urn:bank:strong"] }), {
      acsUrl: ACS, flow, relayState: relay, samlResponse: samlResponse({ inResponseTo: requestId, attributes: attrs, authnContext: "urn:bank:strong" }),
    })
    expect(who.mfaProven).toBe(true)
  })
})

describe("SAML refusals", () => {
  const attempt = async (over: Parameters<typeof samlResponse>[0], tweak: { relay?: string | null; flowTenant?: string; conn?: LoadedConnection } = {}) => {
    const { flow, requestId, relay } = await begin()
    return failure(completeSaml(tweak.conn ?? conn(), {
      acsUrl: ACS, flow: tweak.flowTenant ? { ...flow, tenantId: tweak.flowTenant } : flow,
      relayState: tweak.relay === undefined ? relay : tweak.relay,
      samlResponse: samlResponse({ inResponseTo: requestId, attributes: attrs, ...over }),
    }))
  }

  it("refuses a bad signature (signed by another key)", async () => {
    expect((await attempt({ signer: testIdp("attacker") }))?.code).toBe("invalid_response")
  })

  it("refuses an assertion whose content was altered after signing", async () => {
    const { flow, requestId, relay } = await begin()
    const xml = Buffer.from(samlResponse({ inResponseTo: requestId, attributes: attrs }), "base64").toString("utf8")
    const forged = Buffer.from(xml.replace("ann@bank.example.test", "ceo@bank.example.test"), "utf8").toString("base64")
    expect((await failure(completeSaml(conn(), { acsUrl: ACS, flow, relayState: relay, samlResponse: forged })))?.code).toBe("invalid_response")
  })

  it("refuses an expired assertion", async () => {
    const past = new Date(Date.now() - 3_600_000)
    expect((await attempt({ notBefore: new Date(past.getTime() - 60_000), notOnOrAfter: past }))?.code).toBe("invalid_response")
  })

  it("refuses an assertion not yet valid", async () => {
    expect((await attempt({ notBefore: new Date(Date.now() + 3_600_000), notOnOrAfter: new Date(Date.now() + 7_200_000) }))?.code).toBe("invalid_response")
  })

  it("refuses an assertion for another audience", async () => {
    expect((await attempt({ audience: "urn:some:other:sp" }))?.code).toBe("invalid_response")
  })

  it("refuses an assertion from another issuer", async () => {
    expect((await attempt({ idpEntityId: "https://evil.example.test/saml" }))?.code).toBe("invalid_response")
  })

  it("refuses a response to a request we never sent (unsolicited / IdP-initiated)", async () => {
    expect((await attempt({ inResponseTo: "_never-issued" }))?.code).toBe("invalid_response")
  })

  it("refuses a response with no InResponseTo", async () => {
    expect((await attempt({ inResponseTo: undefined }))?.code).toBe("invalid_response")
  })

  it("refuses a replayed response", async () => {
    const { flow, requestId, relay } = await begin()
    const response = samlResponse({ inResponseTo: requestId, attributes: attrs })
    await completeSaml(conn(), { acsUrl: ACS, flow, relayState: relay, samlResponse: response })
    expect((await failure(completeSaml(conn(), { acsUrl: ACS, flow, relayState: relay, samlResponse: response })))?.code).toBe("invalid_response")
  })

  it("refuses a replayed assertion id even when wrapped to answer a new request", async () => {
    const first = await begin()
    await completeSaml(conn(), { acsUrl: ACS, flow: first.flow, relayState: first.relay, samlResponse: samlResponse({ inResponseTo: first.requestId, attributes: attrs, assertionId: "_same-assertion" }) })
    const second = await begin()
    const e = await failure(completeSaml(conn(), { acsUrl: ACS, flow: second.flow, relayState: second.relay, samlResponse: samlResponse({ inResponseTo: second.requestId, attributes: attrs, assertionId: "_same-assertion" }) }))
    expect(e?.code).toBe("invalid_response")
  })

  it("refuses a relay state that is not the browser's", async () => {
    expect((await attempt({}, { relay: "forged" }))?.code).toBe("state_mismatch")
    expect((await attempt({}, { relay: null }))?.code).toBe("state_mismatch")
  })

  it("refuses a flow state from another lender", async () => {
    expect((await attempt({}, { flowTenant: "t2" }))?.code).toBe("missing_state")
  })

  it("refuses a Recipient that is not our ACS", async () => {
    expect((await attempt({ destination: "https://other.example.test/acs" }))?.code).toBe("bad_recipient")
  })

  it("refuses a certificate the lender did not configure", async () => {
    expect((await attempt({}, { conn: conn({ samlIdpCert: testIdp("someone-else").certPem }) }))?.code).toBe("invalid_response")
  })

  it("refuses an identity with no email", async () => {
    expect((await attempt({ nameId: "opaque-id-123", attributes: {} }))?.code).toBe("no_email")
  })
})
