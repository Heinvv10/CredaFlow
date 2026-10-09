import { describe, it, expect } from "vitest"
import { renderTokens, resolveToken, TOKEN_REGISTRY, type TokenContext } from "./tokens"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const baseCtx = {
  tenant: { id: "t1", slug: "acme", name: "Acme Lending" },
  lender: parseLenderIdentity(VALID_LENDER_COLUMNS),
  client: {
    id: "c1",
    firstName: "Thabo",
    lastName: "M",
    idNumber: "9001015800081",
    email: "thabo@example.com",
    phone: "0821234567",
    addressLine1: "12 Main Street",
    city: "Pretoria",
  },
} as unknown as TokenContext

describe("resolveToken", () => {
  it("resolves client.fullName from firstName + lastName", () => {
    expect(resolveToken("client.fullName", baseCtx)).toBe("Thabo M")
  })

  it("resolves client.physicalAddress from addressLine1 + city", () => {
    expect(resolveToken("client.physicalAddress", baseCtx)).toBe("12 Main Street, Pretoria")
  })

  it("returns null for an unknown token", () => {
    expect(resolveToken("client.nope", baseCtx)).toBeNull()
  })

  it("returns null for a loan.* token when ctx.loan is absent", () => {
    expect(resolveToken("loan.reference", baseCtx)).toBeNull()
    expect(resolveToken("loan.principal", baseCtx)).toBeNull()
  })

  it("resolves loan.* tokens when ctx.loan is present", () => {
    const ctx = {
      ...baseCtx,
      loan: {
        reference: "LN-0001",
        principal: 500000,
        outstandingPrincipal: 250000,
        interestRatePm: 0.05,
        startDate: new Date("2026-01-01"),
        maturityDate: new Date("2026-07-01"),
      },
    } as unknown as TokenContext
    expect(resolveToken("loan.reference", ctx)).toBe("LN-0001")
    expect(resolveToken("loan.principal", ctx)).toBe("R 5,000.00")
    expect(resolveToken("loan.outstandingBalance", ctx)).toBe("R 2,500.00")
    expect(resolveToken("loan.interestRate", ctx)).toBe("5.00% per month")
    expect(resolveToken("loan.term", ctx)).toBe("6 months")
  })

  it("resolves application.product when the product relation is present", () => {
    const ctx = {
      ...baseCtx,
      application: {
        reference: "APP-0001",
        appliedAmount: 100000,
        product: { name: "Personal Loan" },
      },
    } as unknown as TokenContext
    expect(resolveToken("application.reference", ctx)).toBe("APP-0001")
    expect(resolveToken("application.amountRequested", ctx)).toBe("R 1,000.00")
    expect(resolveToken("application.product", ctx)).toBe("Personal Loan")
  })

  it("resolves staff.name when a staff member is present, null otherwise", () => {
    expect(resolveToken("staff.name", baseCtx)).toBeNull()
    const ctx = { ...baseCtx, staff: { name: "Agent Smith" } } as unknown as TokenContext
    expect(resolveToken("staff.name", ctx)).toBe("Agent Smith")
  })

  it("resolves tenant.* tokens from the tenant's configured identity", () => {
    expect(resolveToken("tenant.legalName", baseCtx)).toBe("Acme Lending (Pty) Ltd")
    expect(resolveToken("tenant.ncrNumber", baseCtx)).toBe("NCRCP99999")
    expect(resolveToken("tenant.registeredAddress", baseCtx)).toBe("1 Main Road, Sandton, 2196")
  })

  it("resolves tenant.legalName from the identity, not ctx.tenant.name", () => {
    const ctx = {
      ...baseCtx,
      tenant: { ...baseCtx.tenant, name: "Some Brand" },
    } as unknown as TokenContext
    expect(resolveToken("tenant.legalName", ctx)).toBe("Acme Lending (Pty) Ltd")
  })

  // F-11: with no configured identity the tokens are missing, so the
  // empty-token guard blocks the document instead of printing a default.
  it("leaves every tenant identity token missing when the identity is not configured", () => {
    const ctx = { ...baseCtx, lender: null } as unknown as TokenContext
    for (const token of ["tenant.legalName", "tenant.ncrNumber", "tenant.registeredAddress"]) {
      expect(resolveToken(token, ctx)).toBeNull()
    }
    expect(renderTokens("<p>{{tenant.ncrNumber}}</p>", ctx).missing).toEqual(["tenant.ncrNumber"])
  })

  it("resolves the system.today token to a non-empty formatted date", () => {
    const today = resolveToken("today", baseCtx)
    expect(today).toBeTruthy()
    expect(typeof today).toBe("string")
  })

  it("every registry entry has token, label and group", () => {
    expect(TOKEN_REGISTRY.length).toBeGreaterThan(0)
    for (const t of TOKEN_REGISTRY) {
      expect(t.token).toBeTruthy()
      expect(t.label).toBeTruthy()
      expect(t.group).toBeTruthy()
    }
  })
})

describe("renderTokens", () => {
  it("fills known tokens and reports no missing tokens", () => {
    const { html, missing } = renderTokens("Hi {{client.fullName}}", baseCtx)
    expect(html).toBe("Hi Thabo M")
    expect(missing).toEqual([])
  })

  it("flags null and empty tokens, leaving them un-substituted", () => {
    const { html, missing } = renderTokens("{{loan.principal}} {{client.nope}}", baseCtx)
    expect(missing.sort()).toEqual(["client.nope", "loan.principal"])
    expect(html).toBe("{{loan.principal}} {{client.nope}}")
  })

  it("resolves a token with surrounding whitespace inside the braces", () => {
    const { html, missing } = renderTokens("Hi {{ client.fullName }}", baseCtx)
    expect(html).toBe("Hi Thabo M")
    expect(missing).toEqual([])
  })

  it("dedupes a repeated unresolved token in the missing list", () => {
    const { missing } = renderTokens("{{client.nope}} and again {{client.nope}}", baseCtx)
    expect(missing).toEqual(["client.nope"])
  })

  it("treats a resolver returning an empty string the same as null", () => {
    // client.idNumber passes ctx.client.idNumber through unchanged, so an
    // empty-string value on the client record exercises the "" branch
    // directly (distinct from the null-when-absent branch above).
    const ctx = {
      ...baseCtx,
      client: { ...baseCtx.client, idNumber: "" },
    } as unknown as TokenContext
    const { html, missing } = renderTokens("ID: {{client.idNumber}}", ctx)
    expect(missing).toEqual(["client.idNumber"])
    expect(html).toBe("ID: {{client.idNumber}}")
  })

  it("HTML-escapes a resolved token value containing markup/metacharacters", () => {
    const ctx = {
      ...baseCtx,
      client: { ...baseCtx.client, firstName: "Smith &", lastName: "<b>Co</b>" },
    } as unknown as TokenContext
    const { html, missing } = renderTokens("Client: {{client.fullName}}", ctx)
    expect(missing).toEqual([])
    expect(html).toBe("Client: Smith &amp; &lt;b&gt;Co&lt;/b&gt;")
    expect(html).not.toContain("<b>")
  })

  it("HTML-escapes a script-injection payload in a resolved token value", () => {
    const ctx = {
      ...baseCtx,
      client: { ...baseCtx.client, firstName: "<script>alert(1)</script>", lastName: "" },
    } as unknown as TokenContext
    const { html } = renderTokens("{{client.firstName}}", ctx)
    expect(html).toBe("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("does not double-escape a normal, already-safe value", () => {
    const { html, missing } = renderTokens("Hi {{client.fullName}}, ID {{client.idNumber}}", baseCtx)
    expect(missing).toEqual([])
    expect(html).toBe("Hi Thabo M, ID 9001015800081")
  })
})
