import { describe, it, expect } from "vitest"
import {
  parseGroup,
  parseType,
  typesInGroup,
  toDashboardClientRecord,
  COMPLIANCE_GROUPS,
} from "./dashboard"
import { COMPLIANCE_TYPE_GROUP } from "./record-types"

const NOW = new Date("2026-08-16T10:00:00Z")

describe("parseType", () => {
  // A blind review confirmed this guard was unprotected: reverting it to `in`
  // passed all 299 compliance tests. `?type=` is user-controlled and flows
  // straight into a Prisma `where`.
  const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]

  it("rejects inherited Object members that `in` would have accepted", () => {
    for (const key of INHERITED) expect(parseType(key)).toBeNull()
  })

  it("accepts every real ComplianceType", () => {
    for (const t of Object.keys(COMPLIANCE_TYPE_GROUP)) expect(parseType(t)).toBe(t)
  })

  it("rejects unknown, empty and undefined input", () => {
    for (const raw of [undefined, "", "NOT_A_TYPE", "ncr_quarterly_return", "0"]) {
      expect(parseType(raw)).toBeNull()
    }
  })

  it("is case-sensitive, matching the Prisma enum exactly", () => {
    expect(parseType("KYC_EXCEPTION")).toBe("KYC_EXCEPTION")
    expect(parseType("kyc_exception")).toBeNull()
  })
})

describe("parseGroup", () => {
  it("accepts the four real groups", () => {
    for (const g of COMPLIANCE_GROUPS) expect(parseGroup(g)).toBe(g)
  })

  it("rejects inherited members and unknown values", () => {
    for (const raw of [undefined, "", "constructor", "toString", "OBLIGATIONS", "obligation"]) {
      expect(parseGroup(raw)).toBeNull()
    }
  })
})

describe("typesInGroup", () => {
  it("partitions every type across the groups exactly once", () => {
    const all = COMPLIANCE_GROUPS.flatMap(typesInGroup)
    expect(all.sort()).toEqual(Object.keys(COMPLIANCE_TYPE_GROUP).sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it("returns a non-empty list for each group", () => {
    for (const g of COMPLIANCE_GROUPS) expect(typesInGroup(g).length).toBeGreaterThan(0)
  })
})

describe("toDashboardClientRecord — POPIA redaction", () => {
  /**
   * A real Section 129 snapshot. Every field here is regulated: the consumer's
   * name, ID number, address and email, their balances, and an absolute path
   * into private storage. A blind review confirmed this redaction had no test
   * at all — replacing it with `data: record.data` passed the whole suite.
   */
  const s129Snapshot = {
    lifecycle: "ISSUED",
    clientName: "Thandiwe Mokoena",
    clientIdNumber: "8801015800081",
    clientEmail: "thandiwe@example.test",
    clientAddressLine1: "12 Long Street",
    clientCity: "Cape Town",
    arrearsAmount: 452300,
    outstandingPrincipal: 1875000,
    daysInArrears: 97,
    pdfPath: "/var/lib/acme/private/s129/abc123.pdf",
    pdfSha256: "9f2b...",
    emailMessageId: "<msg@provider>",
  }

  type Row = Parameters<typeof toDashboardClientRecord>[0]

  const row = (over: Partial<Row> = {}): Row => ({
    id: "rec-1",
    type: "SECTION_129_NOTICE",
    status: "PENDING",
    referenceId: "loan-1",
    dueDate: null,
    completedAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    data: s129Snapshot as Row["data"],
    ...over,
  })

  it("passes lifecycle through and nothing else", () => {
    const out = toDashboardClientRecord(row(), NOW)
    expect(out.data).toEqual({ lifecycle: "ISSUED" })
  })

  it("leaks no regulated field, checked value by value", () => {
    const out = toDashboardClientRecord(row(), NOW)
    const serialised = JSON.stringify(out)
    for (const secret of [
      "Thandiwe", "Mokoena", "8801015800081", "thandiwe@example.test",
      "Long Street", "Cape Town", "452300", "1875000",
      "/var/lib/acme/private", "9f2b", "msg@provider",
    ]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it("carries exactly the expected keys, so a new model field cannot leak by default", () => {
    const out = toDashboardClientRecord(row(), NOW)
    expect(Object.keys(out).sort()).toEqual([
      "completedAt", "createdAt", "data", "dueDate", "id",
      "referenceId", "section129RecoveryAvailable", "status", "type",
    ])
  })

  it("drops a field added to the source row that the projection does not name", () => {
    const withExtra = { ...row(), clientIdNumber: "8801015800081", secretPath: "/private/x" }
    const out = toDashboardClientRecord(withExtra, NOW)
    expect(JSON.stringify(out)).not.toContain("8801015800081")
    expect(JSON.stringify(out)).not.toContain("/private/x")
  })

  it("emits an empty data object when there is no lifecycle", () => {
    expect(toDashboardClientRecord(row({ data: { clientIdNumber: "8801015800081" } as Row["data"] }), NOW).data)
      .toEqual({})
  })

  it("ignores a non-string lifecycle rather than forwarding it", () => {
    for (const bad of [{ lifecycle: 42 }, { lifecycle: null }, { lifecycle: { a: 1 } }]) {
      expect(toDashboardClientRecord(row({ data: bad as Row["data"] }), NOW).data).toEqual({})
    }
  })

  it("handles null and array data without throwing", () => {
    expect(toDashboardClientRecord(row({ data: null }), NOW).data).toEqual({})
    expect(toDashboardClientRecord(row({ data: [1, 2, 3] }), NOW).data).toEqual({})
  })

  it("preserves the non-sensitive lifecycle fields the table renders", () => {
    const out = toDashboardClientRecord(row(), NOW)
    expect(out).toMatchObject({
      id: "rec-1",
      type: "SECTION_129_NOTICE",
      status: "PENDING",
      referenceId: "loan-1",
    })
  })

  it("only offers Section 129 recovery for a pending Section 129 record", () => {
    expect(toDashboardClientRecord(row({ type: "KYC_EXCEPTION" }), NOW).section129RecoveryAvailable)
      .toBe(false)
    expect(toDashboardClientRecord(row({ status: "COMPLETED" }), NOW).section129RecoveryAvailable)
      .toBe(false)
  })
})
