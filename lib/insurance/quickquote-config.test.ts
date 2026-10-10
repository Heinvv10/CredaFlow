import { describe, expect, it } from "vitest"
import {
  buildQuoteFrameSrc,
  isQuickQuoteHost,
  isQuickQuoteView,
  isMultiVehicleEnabled,
  isMultiRiskEnabled,
  resolveQuickQuoteConfig,
  resolveQuickQuoteEmbedOrigin,
  resolveQuickQuoteHostConfig,
  isQuickQuoteEmbeddingHost,
  quickQuoteFrameAncestors,
} from "./quickquote-config"

const HOSTS_ENV = {
  FSP_QUICKQUOTE_HOSTS: "quote.acme-lending.example,quote-staging.acme-lending.example",
  FSP_QUICKQUOTE_FRAME_ANCESTORS:
    "https://acme-lending.example,https://www.acme-lending.example,https://staging.acme-lending.example",
}

const COMPLETE = {
  FSP_QUICKQUOTE_ENABLED: "true",
  FSP_QUICKQUOTE_EBC: "vzUT7fUr04tA9mthZtFAoA==",
  FSP_QUICKQUOTE_ELEAD: "5h/lFnjDN2NN4TTNksWrJsfF0mnhPmQ4ZwSkHy6jAhcxvn2HF9wE1WTE2",
  FSP_QUICKQUOTE_BROKER_EMAIL: "insurance@acme-lending.example",
  FSP_QUICKQUOTE_BROKER_NAME: "ACME LENDING (PTY) LTD",
}

/** The four credential keys, each of which must independently gate the embed. */
const CREDENTIAL_KEYS = [
  "FSP_QUICKQUOTE_EBC",
  "FSP_QUICKQUOTE_ELEAD",
  "FSP_QUICKQUOTE_BROKER_EMAIL",
  "FSP_QUICKQUOTE_BROKER_NAME",
] as const

describe("resolveQuickQuoteConfig", () => {
  it("returns all four credentials when the flag is on and every value is set", () => {
    expect(resolveQuickQuoteConfig(COMPLETE)).toEqual({
      ebc: "vzUT7fUr04tA9mthZtFAoA==",
      elead: "5h/lFnjDN2NN4TTNksWrJsfF0mnhPmQ4ZwSkHy6jAhcxvn2HF9wE1WTE2",
      brokerContactEmail: "insurance@acme-lending.example",
      brokerName: "ACME LENDING (PTY) LTD",
    })
  })

  it("returns null when the feature flag is absent", () => {
    const { FSP_QUICKQUOTE_ENABLED: _omitted, ...withoutFlag } = COMPLETE
    expect(resolveQuickQuoteConfig(withoutFlag)).toBeNull()
  })

  it.each(["false", "1", "TRUE", "yes", ""])(
    "returns null when the flag is %o rather than exactly \"true\"",
    (flag) => {
      expect(
        resolveQuickQuoteConfig({ ...COMPLETE, FSP_QUICKQUOTE_ENABLED: flag }),
      ).toBeNull()
    },
  )

  // Each key is removed on its own. A widget missing only `elead` still
  // renders and still quotes — it just mails every lead to FSP's default
  // itteam@fspsolutions.com mailbox. That is the failure this guard exists to
  // prevent, so every key is asserted, not a sample.
  it.each(CREDENTIAL_KEYS)("returns null when %s is missing", (key) => {
    const env = { ...COMPLETE }
    delete (env as Record<string, string | undefined>)[key]
    expect(resolveQuickQuoteConfig(env)).toBeNull()
  })

  it.each(CREDENTIAL_KEYS)("returns null when %s is blank", (key) => {
    expect(resolveQuickQuoteConfig({ ...COMPLETE, [key]: "" })).toBeNull()
  })

  it.each(CREDENTIAL_KEYS)("returns null when %s is whitespace only", (key) => {
    expect(resolveQuickQuoteConfig({ ...COMPLETE, [key]: "   " })).toBeNull()
  })

  // An unconfigured container must fail closed, not fall through to a default.
  // Passing no env at all is the state of every environment that has not been
  // given credentials — the common case, and the one a guard keyed only on
  // "is the value wrong" would silently pass.
  it("returns null for a completely empty environment", () => {
    expect(resolveQuickQuoteConfig({})).toBeNull()
  })

  it("trims surrounding whitespace off credentials", () => {
    expect(
      resolveQuickQuoteConfig({ ...COMPLETE, FSP_QUICKQUOTE_EBC: "  abc  " }),
    ).toMatchObject({ ebc: "abc" })
  })
})

describe("resolveQuickQuoteEmbedOrigin", () => {
  const withOrigin = (origin: string) => ({
    ...COMPLETE,
    ...HOSTS_ENV,
    FSP_QUICKQUOTE_EMBED_ORIGIN: origin,
  })

  it("returns the https origin when configured", () => {
    expect(
      resolveQuickQuoteEmbedOrigin(withOrigin("https://quote.acme-lending.example")),
    ).toBe("https://quote.acme-lending.example")
  })

  it("reduces a full URL to its origin", () => {
    expect(
      resolveQuickQuoteEmbedOrigin(withOrigin("https://quote.acme-lending.example/quote?x=1")),
    ).toBe("https://quote.acme-lending.example")
  })

  it("returns null when the flag is off", () => {
    expect(
      resolveQuickQuoteEmbedOrigin({
        ...withOrigin("https://quote.acme-lending.example"),
        FSP_QUICKQUOTE_ENABLED: "false",
      }),
    ).toBeNull()
  })

  it("returns null when no origin is configured", () => {
    expect(resolveQuickQuoteEmbedOrigin({ ...COMPLETE, ...HOSTS_ENV })).toBeNull()
  })

  // The marketing page gates its whole section on this value. If it resolved
  // on the origin alone, a deploy holding the origin but missing a credential
  // would advertise the service over an iframe that 404s.
  it.each(CREDENTIAL_KEYS)("returns null when %s is missing", (key) => {
    const env: Record<string, string | undefined> = withOrigin(
      "https://quote.acme-lending.example",
    )
    delete env[key]
    expect(resolveQuickQuoteEmbedOrigin(env)).toBeNull()
  })

  it("returns null for a completely empty environment", () => {
    expect(resolveQuickQuoteEmbedOrigin({})).toBeNull()
  })

  // The value lands in an iframe src. A non-https scheme is the one env-var
  // mistake that would turn configuration into script execution on a page we
  // control, so it is refused rather than passed through.
  it.each([
    "http://quote.acme-lending.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//quote.acme-lending.example",
    "quote.acme-lending.example",
    "not a url",
  ])("returns null for the unsafe or malformed origin %o", (origin) => {
    expect(resolveQuickQuoteEmbedOrigin(withOrigin(origin))).toBeNull()
  })
})

describe("isQuickQuoteView", () => {
  it.each(["motor", "home", "building"])("accepts %o", (view) => {
    expect(isQuickQuoteView(view)).toBe(true)
  })

  it.each(["MOTOR", "contents", "", null, undefined, 1])("rejects %o", (view) => {
    expect(isQuickQuoteView(view)).toBe(false)
  })
})

// The origins that carry a staff or client session cookie. FSP's bundle
// running in any of these is the failure the whole iframe design exists to
// prevent, so each is asserted individually rather than as a sample.
const SESSION_BEARING_HOSTS = [
  "app.acme-lending.example",
  "portal.acme-lending.example",
  "acme-lending.example",
  "www.acme-lending.example",
  "staging.acme-lending.example",
]

const PROD = { NODE_ENV: "production", ...HOSTS_ENV }

describe("isQuickQuoteHost", () => {
  it.each(["quote.acme-lending.example", "quote-staging.acme-lending.example"])(
    "allows the dedicated quote host %o in production",
    (host) => {
      expect(isQuickQuoteHost(host, PROD)).toBe(true)
    },
  )

  it.each(SESSION_BEARING_HOSTS)("refuses the session-bearing host %o", (host) => {
    expect(isQuickQuoteHost(host, PROD)).toBe(false)
  })

  it.each([null, undefined, ""])("refuses the absent host %o", (host) => {
    expect(isQuickQuoteHost(host, PROD)).toBe(false)
  })

  it("refuses an unknown host outright rather than pattern-matching it", () => {
    expect(isQuickQuoteHost("quote.attacker.example", PROD)).toBe(false)
    expect(isQuickQuoteHost("quote.acme-lending.example.attacker.example", PROD)).toBe(false)
  })

  // The host list is env, so a misconfiguration must not be able to put FSP's
  // bundle on an origin that carries a session cookie or frames it.
  it.each([
    ["the staff app host", { STAFF_APP_HOST: "app.acme-lending.example" }, "app.acme-lending.example"],
    ["the public website", { NEXT_PUBLIC_WEBSITE_URL: "https://www.acme-lending.example" }, "www.acme-lending.example"],
    ["the client portal", { NEXT_PUBLIC_PORTAL_URL: "https://portal.acme-lending.example" }, "portal.acme-lending.example"],
    ["the staff app URL", { NEXTAUTH_URL: "https://app.acme-lending.example" }, "app.acme-lending.example"],
    ["an embedding origin", {}, "www.acme-lending.example"],
  ] as const)("refuses a quote host that is also %s", (_what, extra, host) => {
    const env = { ...PROD, ...extra, FSP_QUICKQUOTE_HOSTS: `quote.acme-lending.example,${host}` }
    expect(isQuickQuoteHost(host, env)).toBe(false)
    expect(isQuickQuoteHost("quote.acme-lending.example", env)).toBe(true)
  })

  it("permits loopback only in development", () => {
    expect(isQuickQuoteHost("localhost", { NODE_ENV: "development", ...HOSTS_ENV })).toBe(true)
    expect(isQuickQuoteHost("localhost", PROD)).toBe(false)
    expect(isQuickQuoteHost("127.0.0.1", PROD)).toBe(false)
  })
})

describe("resolveQuickQuoteEmbedOrigin — host allow-list", () => {
  // A scheme check alone passes this. Pointing the embed at our own marketing
  // origin makes the frame same-origin with its parent, where
  // allow-scripts + allow-same-origin is escapable.
  it.each(SESSION_BEARING_HOSTS)(
    "refuses an embed origin pointed at our own host %o",
    (host) => {
      expect(
        resolveQuickQuoteEmbedOrigin({
          ...COMPLETE,
          ...PROD,
          FSP_QUICKQUOTE_EMBED_ORIGIN: `https://${host}`,
        }),
      ).toBeNull()
    },
  )

  it("accepts the dedicated quote host", () => {
    expect(
      resolveQuickQuoteEmbedOrigin({
        ...COMPLETE,
        ...PROD,
        FSP_QUICKQUOTE_EMBED_ORIGIN: "https://quote.acme-lending.example",
      }),
    ).toBe("https://quote.acme-lending.example")
  })
})

describe("resolveQuickQuoteHostConfig", () => {
  const env = {
    ...COMPLETE,
    ...PROD,
    FSP_QUICKQUOTE_EMBED_ORIGIN: "https://quote.acme-lending.example",
  }

  it("returns the config on an allow-listed quote host", () => {
    expect(resolveQuickQuoteHostConfig("quote.acme-lending.example", env)).toMatchObject({
      ebc: "vzUT7fUr04tA9mthZtFAoA==",
    })
  })

  it.each(SESSION_BEARING_HOSTS)("returns null on the session-bearing host %o", (host) => {
    expect(resolveQuickQuoteHostConfig(host, env)).toBeNull()
  })

  // The state that shipped before: credentials present, embed origin absent.
  // The marketing page went dark while the quote host stayed live and served
  // FSP's script, contradicting this module's own "all or nothing" rule.
  it("returns null when the embed origin is absent even on the right host", () => {
    const { FSP_QUICKQUOTE_EMBED_ORIGIN: _omitted, ...withoutOrigin } = env
    expect(resolveQuickQuoteHostConfig("quote.acme-lending.example", withoutOrigin)).toBeNull()
  })

  it.each(CREDENTIAL_KEYS)("returns null when %s is missing", (key) => {
    const broken: Record<string, string | undefined> = { ...env }
    delete broken[key]
    expect(resolveQuickQuoteHostConfig("quote.acme-lending.example", broken)).toBeNull()
  })

  it("returns null for a completely empty environment", () => {
    expect(resolveQuickQuoteHostConfig("quote.acme-lending.example", {})).toBeNull()
  })
})

describe("embedding hosts and frame-ancestors stay aligned", () => {
  const PRODUCTION = { NODE_ENV: "production", ...HOSTS_ENV }
  const DEVELOPMENT = { NODE_ENV: "development", ...HOSTS_ENV }

  /**
   * frame-ancestors entries are CSP source expressions, not URLs — the dev
   * ones carry a `:*` port wildcard that `new URL()` refuses to parse. Strip
   * scheme and port textually instead.
   */
  const hostOf = (source: string) => source.replace(/^https?:\/\//, "").split(":")[0]

  // The direction that actually produces the dead box is gate ⊄ framed: the
  // panel rendering on a host the CSP will not permit to be framed. Asserted
  // as a set equality so BOTH directions fail, not just the harmless one.
  it.each([PRODUCTION, DEVELOPMENT])(
    "permits framing by exactly the hosts the panel renders on, in %o",
    (env) => {
      const framed = quickQuoteFrameAncestors(env).map(hostOf)
      const gated = framed.filter((host) => isQuickQuoteEmbeddingHost(host, env))

      expect([...gated].sort()).toEqual([...framed].sort())
      for (const host of framed) {
        expect(isQuickQuoteEmbeddingHost(host, env)).toBe(true)
      }
    },
  )

  // Guards the reverse membership directly: a loopback host added to the gate
  // list alone must not be able to slip through without a matching CSP entry.
  it("frames every loopback host it renders the panel on in development", () => {
    const framed = quickQuoteFrameAncestors(DEVELOPMENT).map(hostOf)
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(isQuickQuoteEmbeddingHost(host, DEVELOPMENT)).toBe(true)
      expect(framed).toContain(host)
    }
  })

  // Fail-safe: anything that is not exactly "development" gets the strict
  // list, so an unset or unexpected NODE_ENV cannot ship loopback origins.
  it.each([{}, { NODE_ENV: "test" }, { NODE_ENV: "staging" }, { NODE_ENV: "" }])(
    "ships no loopback origin under the ambiguous env %o",
    (ambiguous) => {
      const env = { ...HOSTS_ENV, ...ambiguous }
      expect(quickQuoteFrameAncestors(env)).toEqual(
        HOSTS_ENV.FSP_QUICKQUOTE_FRAME_ANCESTORS.split(","),
      )
      expect(isQuickQuoteEmbeddingHost("localhost", env)).toBe(false)
      expect(isQuickQuoteHost("localhost", env)).toBe(false)
    },
  )

  it.each(["app.acme-lending.example", "portal.acme-lending.example"])(
    "does not offer the panel on the authenticated host %s",
    (host) => {
      expect(isQuickQuoteEmbeddingHost(host, PRODUCTION)).toBe(false)
    },
  )

  // The quote host CAN frame itself — 'self' is in the directive. What must
  // not happen is it appearing in the embedding list, which would also make
  // the insurance page render there.
  it("does not list the quote host among the embedding origins", () => {
    expect(quickQuoteFrameAncestors(PRODUCTION).map(hostOf)).not.toContain(
      "quote.acme-lending.example",
    )
    expect(isQuickQuoteEmbeddingHost("quote.acme-lending.example", PRODUCTION)).toBe(false)
  })
})

describe("isMultiVehicleEnabled", () => {
  it("is off when unset", () => {
    expect(isMultiVehicleEnabled({})).toBe(false)
  })

  it("is on only for the exact string true", () => {
    expect(isMultiVehicleEnabled({ FSP_QUICKQUOTE_MULTI_VEHICLE: "true" })).toBe(true)
  })

  it.each(["TRUE", "1", "yes", "on", ""])("is off for %p", (raw) => {
    expect(isMultiVehicleEnabled({ FSP_QUICKQUOTE_MULTI_VEHICLE: raw })).toBe(false)
  })

  // `value()` trims before comparing, so a stray space in a .env file still
  // enables the flag. That is the existing behaviour of every other gate in
  // this module and is asserted rather than left to be discovered.
  it("tolerates surrounding whitespace, as every other gate here does", () => {
    expect(isMultiVehicleEnabled({ FSP_QUICKQUOTE_MULTI_VEHICLE: " true " })).toBe(true)
  })
})

describe("isMultiRiskEnabled", () => {
  it("is off when unset", () => {
    expect(isMultiRiskEnabled({})).toBe(false)
  })

  it("is on only for the exact string true", () => {
    expect(isMultiRiskEnabled({ FSP_QUICKQUOTE_MULTI_RISK: "true" })).toBe(true)
  })

  it.each(["TRUE", "1", "yes", "on", ""])("is off for %p", (raw) => {
    expect(isMultiRiskEnabled({ FSP_QUICKQUOTE_MULTI_RISK: raw })).toBe(false)
  })

  it("tolerates surrounding whitespace, as every other gate here does", () => {
    expect(isMultiRiskEnabled({ FSP_QUICKQUOTE_MULTI_RISK: " true " })).toBe(true)
  })

  // The two journey flags are independent. Multi-vehicle changes the MOTOR
  // journey and multi-risk adds two others; tying them together would mean
  // switching off a misbehaving home tab also took away the second car.
  it("is independent of the multi-vehicle flag", () => {
    expect(isMultiRiskEnabled({ FSP_QUICKQUOTE_MULTI_VEHICLE: "true" })).toBe(false)
    expect(isMultiVehicleEnabled({ FSP_QUICKQUOTE_MULTI_RISK: "true" })).toBe(false)
  })
})

/* The SENDING half of the plate contract. The receiving half (resolvePlate on
   the quote host) is allow-listed and tested there; without these, dropping the
   encoding or naming the wrong view would ship green, because the receiver
   would quietly fall back to its default and the two halves would disagree
   again — the exact failure the contract exists to end. */
describe("buildQuoteFrameSrc", () => {
  const ORIGIN = "https://quote.acme-lending.example"

  it("names the view the frame must serve", () => {
    expect(buildQuoteFrameSrc(ORIGIN, "building")).toBe(`${ORIGIN}/quote?view=building`)
  })

  /* The plate is root-relative, so its leading slash MUST be escaped — raw, it
     ends the query value early and the frame receives an empty plate. */
  it("percent-encodes the plate rather than pasting it in raw", () => {
    const src = buildQuoteFrameSrc(ORIGIN, "home", "/plate-home-2.webp")
    expect(src).toBe(`${ORIGIN}/quote?view=home&plate=%2Fplate-home-2.webp`)
    expect(src).not.toContain("plate=/")
  })

  /* Absent, not empty: the receiver's fallback should be reached by a missing
     parameter, never by a present one it has to reject. */
  it.each([undefined, ""])("omits the parameter entirely for %o", (plate) => {
    const src = buildQuoteFrameSrc(ORIGIN, "motor", plate)
    expect(src).toBe(`${ORIGIN}/quote?view=motor`)
    expect(src).not.toContain("plate")
  })

  it("keeps the plate a separate parameter rather than fusing it to the view", () => {
    const src = buildQuoteFrameSrc(ORIGIN, "motor", "/plate-vehicle-1.webp")
    expect(new URL(src).searchParams.get("view")).toBe("motor")
    expect(new URL(src).searchParams.get("plate")).toBe("/plate-vehicle-1.webp")
  })
})

/* Decision: no quote host is baked in. Unset means OFF, in every
   environment, including development. */
describe("quote host and frame-ancestors come from env only", () => {
  const UNSET_ENVS = [
    {},
    { NODE_ENV: "production" },
    { NODE_ENV: "development" },
    { FSP_QUICKQUOTE_HOSTS: "", FSP_QUICKQUOTE_FRAME_ANCESTORS: "" },
    { FSP_QUICKQUOTE_HOSTS: " , ,", FSP_QUICKQUOTE_FRAME_ANCESTORS: " , " },
  ]

  it.each(UNSET_ENVS)("is off for any host when nothing is configured: %o", (env) => {
    for (const host of ["quote.acme-lending.example", "localhost", "127.0.0.1", "example.com"]) {
      expect(isQuickQuoteHost(host, env)).toBe(false)
      expect(isQuickQuoteEmbeddingHost(host, env)).toBe(false)
    }
    expect(quickQuoteFrameAncestors(env)).toEqual([])
  })

  it("is on for exactly the configured hosts, trimmed and lowercased", () => {
    const env = { FSP_QUICKQUOTE_HOSTS: " Quote.Acme-Lending.Example , q2.acme-lending.example " }
    expect(isQuickQuoteHost("quote.acme-lending.example", env)).toBe(true)
    expect(isQuickQuoteHost("q2.acme-lending.example", env)).toBe(true)
    expect(isQuickQuoteHost("www.acme-lending.example", env)).toBe(false)
  })

  it("adds loopback in development only when a host is configured", () => {
    const env = { NODE_ENV: "development", FSP_QUICKQUOTE_HOSTS: "quote.acme-lending.example" }
    expect(isQuickQuoteHost("localhost", env)).toBe(true)
    expect(isQuickQuoteHost("localhost", { ...env, NODE_ENV: "production" })).toBe(false)
  })

  it("turns frame-ancestors on from env", () => {
    expect(
      quickQuoteFrameAncestors({
        NODE_ENV: "production",
        FSP_QUICKQUOTE_FRAME_ANCESTORS: "https://www.acme-lending.example",
      }),
    ).toEqual(["https://www.acme-lending.example"])
  })

  // A malformed entry may only narrow the list. It must never be repaired into
  // something wider, and must never reach the CSP header.
  it.each([
    "http://www.acme-lending.example",
    "www.acme-lending.example",
    "https://*.acme-lending.example",
    "https://www.acme-lending.example/path",
    "https://user:pw@www.acme-lending.example",
    "https:// www.acme-lending.example",
    "javascript:alert(1)",
    "https://www.acme-lending.example; script-src *",
    "'none'",
    "*",
  ])("ignores the malformed frame ancestor %o", (bad) => {
    const env = {
      NODE_ENV: "production",
      FSP_QUICKQUOTE_FRAME_ANCESTORS: `${bad},https://ok.acme-lending.example`,
    }
    expect(quickQuoteFrameAncestors(env)).toEqual(["https://ok.acme-lending.example"])
  })

  it.each([
    "https://quote.acme-lending.example",
    "quote.acme-lending.example:3000",
    "*.acme-lending.example",
    "quote.acme-lending.example/quote",
    "-bad.example",
    "a b.example",
  ])("ignores the malformed quote host %o", (bad) => {
    const env = { FSP_QUICKQUOTE_HOSTS: `${bad},quote.acme-lending.example` }
    expect(isQuickQuoteHost("quote.acme-lending.example", env)).toBe(true)
    expect(isQuickQuoteHost(bad, env)).toBe(false)
    expect(isQuickQuoteHost("*.acme-lending.example", env)).toBe(false)
  })

  it("is off when every entry is malformed", () => {
    expect(isQuickQuoteHost("localhost", { NODE_ENV: "development", FSP_QUICKQUOTE_HOSTS: "https://x" })).toBe(false)
    expect(quickQuoteFrameAncestors({ NODE_ENV: "development", FSP_QUICKQUOTE_FRAME_ANCESTORS: "http://x" })).toEqual([])
  })
})
