import { describe, expect, it } from "vitest"
import { buildOpenApiDocument } from "@/lib/lender-api/openapi"
import { API_SCOPES } from "@/lib/lender-api/scopes"

const doc = buildOpenApiDocument("https://api.lender.example")

describe("OpenAPI document: OAuth 2.0 and mutual TLS", () => {
  it("publishes the client-credentials flow with every scope", () => {
    const scheme = doc.components.securitySchemes.oauth2
    expect(scheme.type).toBe("oauth2")
    expect(scheme.flows.clientCredentials.tokenUrl).toBe("/api/auth/oauth/token")
    expect(Object.keys(scheme.flows.clientCredentials.scopes).sort()).toEqual([...API_SCOPES].sort())
  })

  it("declares the mutualTLS scheme", () => {
    expect(doc.components.securitySchemes.mutualTLS.type).toBe("mutualTLS")
  })

  it("accepts an access token wherever it accepts an API key, with the same scope", () => {
    type Op = { security?: Array<Record<string, string[]>>; "x-required-scope"?: string }
    const ops = Object.values(doc.paths).flatMap((item) => Object.values(item as Record<string, Op>)).filter((op) => op["x-required-scope"])
    expect(ops.length).toBeGreaterThan(5)
    for (const op of ops) {
      const scope = op["x-required-scope"]!
      expect(op.security).toEqual([{ apiKey: [scope] }, { oauth2: [scope] }])
    }
  })
})
