import { describe, it, expect } from "vitest"
import type { LoanStatus } from "@prisma/client"
import { clientStatus, creditBlock } from "./status"

/**
 * The whole point of this suite is the PAID_UP boundary.
 *
 * The obvious rule — "no ACTIVE loan means paid up" — is wrong in a way that
 * matters: it stamps a defaulter, and someone whose debt we wrote off at a
 * loss, as settled on their own client record. So every LoanStatus value is
 * asserted individually below rather than by sampling, and the two dangerous
 * ones get named tests of their own.
 */

const client = (over: Partial<Parameters<typeof clientStatus>[0]> = {}) => ({
  deceasedAt: null,
  blacklisted: false,
  loans: [],
  ...over,
})

const loans = (...statuses: LoanStatus[]) => statuses.map((status) => ({ status }))

describe("clientStatus — asserted facts win", () => {
  it("reports DECEASED when a date of death is recorded", () => {
    expect(clientStatus(client({ deceasedAt: new Date("2026-08-01") }))).toBe("DECEASED")
  })

  it("reports BLACKLISTED when the client is blacklisted", () => {
    expect(clientStatus(client({ blacklisted: true }))).toBe("BLACKLISTED")
  })

  it("prefers DECEASED over BLACKLISTED when both are true", () => {
    // Death is the more absolute fact, and the one staff must not miss.
    expect(clientStatus(client({ deceasedAt: new Date("2026-08-01"), blacklisted: true }))).toBe(
      "DECEASED"
    )
  })

  it("reports DECEASED even while a loan is still running", () => {
    expect(
      clientStatus(client({ deceasedAt: new Date("2026-08-01"), loans: loans("ACTIVE") }))
    ).toBe("DECEASED")
  })
})

describe("clientStatus — derived from loans", () => {
  it("reports ACTIVE for a client with no loans at all", () => {
    expect(clientStatus(client())).toBe("ACTIVE")
  })

  it("reports ACTIVE while any loan is running", () => {
    expect(clientStatus(client({ loans: loans("ACTIVE") }))).toBe("ACTIVE")
  })

  it("reports PAID_UP once the only loan is COMPLETED", () => {
    expect(clientStatus(client({ loans: loans("COMPLETED") }))).toBe("PAID_UP")
  })

  it("reports PAID_UP when every loan of several is COMPLETED", () => {
    expect(clientStatus(client({ loans: loans("COMPLETED", "COMPLETED") }))).toBe("PAID_UP")
  })

  it("reports ACTIVE when one loan is settled and another still runs", () => {
    expect(clientStatus(client({ loans: loans("COMPLETED", "ACTIVE") }))).toBe("ACTIVE")
  })
})

describe("clientStatus — a client who did not pay is never PAID_UP", () => {
  it("does not call a DEFAULTED client paid up", () => {
    expect(clientStatus(client({ loans: loans("DEFAULTED") }))).not.toBe("PAID_UP")
  })

  it("does not call a WRITTEN_OFF client paid up", () => {
    // We took the loss. That is the opposite of settlement.
    expect(clientStatus(client({ loans: loans("WRITTEN_OFF") }))).not.toBe("PAID_UP")
  })

  it("does not call a client paid up when a settled loan sits beside a defaulted one", () => {
    expect(clientStatus(client({ loans: loans("COMPLETED", "DEFAULTED") }))).not.toBe("PAID_UP")
  })

  it("does not call a client paid up when a settled loan sits beside a written-off one", () => {
    expect(clientStatus(client({ loans: loans("COMPLETED", "WRITTEN_OFF") }))).not.toBe("PAID_UP")
  })

  it.each<LoanStatus>(["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF", "RESTRUCTURED", "WRITTEN_OFF"])(
    "treats %s as unfinished business, so a COMPLETED loan beside it is not PAID_UP",
    (status) => {
      expect(clientStatus(client({ loans: loans("COMPLETED", status) }))).not.toBe("PAID_UP")
    }
  )
})

describe("clientStatus — CANCELLED never stands on its own", () => {
  it("reports ACTIVE for a client whose only loan was cancelled", () => {
    // A cancelled loan never ran, so it is neither settlement nor exposure.
    expect(clientStatus(client({ loans: loans("CANCELLED") }))).toBe("ACTIVE")
  })

  it("still reports PAID_UP when a cancelled loan sits beside a completed one", () => {
    expect(clientStatus(client({ loans: loans("COMPLETED", "CANCELLED") }))).toBe("PAID_UP")
  })
})

describe("creditBlock", () => {
  it("lets an ordinary client through", () => {
    expect(creditBlock(client())).toEqual({ blocked: false })
  })

  it("blocks a blacklisted client and says why", () => {
    expect(creditBlock(client({ blacklisted: true }))).toEqual({
      blocked: true,
      reason: "BLACKLISTED",
      auditReason: "client_blacklisted",
    })
  })

  it("blocks a deceased client under its own audit reason", () => {
    // Distinct from client_blacklisted: the audit trail has to tell an estate
    // apart from a credit decision.
    expect(creditBlock(client({ deceasedAt: new Date("2026-08-01") }))).toEqual({
      blocked: true,
      reason: "DECEASED",
      auditReason: "client_deceased",
    })
  })

  it("reports DECEASED first when the client is both", () => {
    expect(creditBlock(client({ deceasedAt: new Date("2026-08-01"), blacklisted: true }))).toEqual({
      blocked: true,
      reason: "DECEASED",
      auditReason: "client_deceased",
    })
  })

  it("does not block a client merely for having settled their loans", () => {
    expect(creditBlock(client({ loans: loans("COMPLETED") }))).toEqual({ blocked: false })
  })
})
