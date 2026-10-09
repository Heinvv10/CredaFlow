import { describe, expect, it } from "vitest"
import {
  sastQuarterBounds,
  section129LogRow,
  section129SentInPeriodWhere,
} from "./section129-reporting"

describe("Section 129 regulatory reporting", () => {
  it.each([
    ["2026-06-30T21:59:59.999Z", "2026-03-31T22:00:00.000Z", "2026-06-30T22:00:00.000Z"],
    ["2026-06-30T22:00:00.000Z", "2026-06-30T22:00:00.000Z", "2026-09-30T22:00:00.000Z"],
    ["2026-12-31T22:30:00.000Z", "2026-12-31T22:00:00.000Z", "2027-03-31T22:00:00.000Z"],
  ])("builds SAST quarter bounds for %s", (now, expectedStart, expectedEnd) => {
    const bounds = sastQuarterBounds(new Date(now))

    expect(bounds.start.toISOString()).toBe(expectedStart)
    expect(bounds.endExclusive.toISOString()).toBe(expectedEnd)
  })

  it("counts only completed ISSUED records by completedAt in an exclusive period", () => {
    const start = new Date("2026-07-01T00:00:00.000Z")
    const endExclusive = new Date("2026-10-01T00:00:00.000Z")

    expect(section129SentInPeriodWhere("tenant-1", start, endExclusive)).toEqual({
      tenantId: "tenant-1",
      type: "SECTION_129_NOTICE",
      status: "COMPLETED",
      completedAt: { gte: start, lt: endExclusive },
      data: { path: ["lifecycle"], equals: "ISSUED" },
    })
  })

  it("uses the immutable issuance snapshot instead of current loan or client data", () => {
    const row = section129LogRow({
      id: "notice-1",
      referenceId: "loan-1",
      status: "COMPLETED",
      createdAt: new Date("2026-07-02T08:00:00.000Z"),
      completedAt: new Date("2026-07-02T08:05:00.000Z"),
      data: {
        lifecycle: "ISSUED",
        loanReference: "LN-ORIGINAL",
        clientName: "Original Recipient",
        clientEmail: "original@example.test",
        clientIdNumber: "9001015000088",
        clientAddressLine1: "1 Original Street",
        clientCity: "Johannesburg",
        outstandingPrincipal: 123_456,
        arrearsAmount: 23_456,
        daysInArrears: 92,
        pdfSha256: "a".repeat(64),
        emailMessageId: "provider-message-1",
        issuedAt: "2026-07-02T08:05:00.000Z",
      },
    }, (date) => date.toISOString())

    expect(row).toMatchObject({
      "Loan Reference": "LN-ORIGINAL",
      "Client Full Name": "Original Recipient",
      "Email": "original@example.test",
      "Outstanding at Attempt (R)": 1234.56,
      "Days in Arrears at Attempt": 92,
      "Arrears Amount at Attempt (R)": 234.56,
      "Attempt Outcome": "ISSUED",
      "Snapshot Source": "IMMUTABLE_ISSUANCE_SNAPSHOT",
      "Provider Evidence Reference": "provider-message-1",
      "Issued At": "2026-07-02T08:05:00.000Z",
    })
  })

  it("formats issuedAt through the same SAST-aware formatter as the other register dates", () => {
    const row = section129LogRow({
      id: "notice-1",
      referenceId: "loan-1",
      status: "COMPLETED",
      createdAt: new Date("2026-07-02T21:59:00.000Z"),
      completedAt: new Date("2026-07-02T22:01:00.000Z"),
      data: { lifecycle: "ISSUED", issuedAt: "2026-07-02T22:00:00.000Z" },
    }, (date) => `SAST:${date.toISOString()}`)

    expect(row["Attempt Created At"]).toBe("SAST:2026-07-02T21:59:00.000Z")
    expect(row["Issued At"]).toBe("SAST:2026-07-02T22:00:00.000Z")
    expect(row["Completed At"]).toBe("SAST:2026-07-02T22:01:00.000Z")
  })

  it("does not expose an invalid issuedAt value as legal-register evidence", () => {
    const row = section129LogRow({
      id: "notice-1",
      referenceId: "loan-1",
      status: "COMPLETED",
      createdAt: new Date("2026-07-02T08:00:00.000Z"),
      completedAt: null,
      data: { lifecycle: "ISSUED", issuedAt: "not-a-date" },
    }, (date) => date.toISOString())

    expect(row["Issued At"]).toBe("")
  })

  it.each([
    ["RECONCILIATION_REQUIRED", "PENDING", "DELIVERY_UNCERTAIN"],
    ["FAILED", "OVERDUE", "KNOWN_NOT_SENT"],
    ["DISPATCHING", "PENDING", "IN_PROGRESS"],
  ])("labels %s attempts without presenting them as sent", (lifecycle, status, expected) => {
    const row = section129LogRow({
      id: "notice-1",
      referenceId: "loan-1",
      status,
      createdAt: new Date("2026-07-02T08:00:00.000Z"),
      completedAt: null,
      data: { lifecycle },
    }, (date) => date.toISOString())

    expect(row["Attempt Outcome"]).toBe(expected)
    expect(row["Attempt Outcome"]).not.toBe("ISSUED")
  })

  it("labels a minimised known-not-sent snapshot as redacted", () => {
    const row = section129LogRow({
      id: "notice-1",
      referenceId: "loan-1",
      status: "OVERDUE",
      createdAt: new Date("2026-07-02T08:00:00.000Z"),
      completedAt: null,
      data: {
        lifecycle: "FAILED",
        loanReference: "LN-1",
        clientEmail: "[REDACTED_AFTER_KNOWN_NOT_SENT]",
        arrearsAmount: 0,
        outstandingPrincipal: 0,
        daysInArrears: 0,
        snapshotRedactedAt: "2026-07-02T08:01:00.000Z",
      },
    }, (date) => date.toISOString())

    expect(row["Snapshot Source"]).toBe("REDACTED_KNOWN_NOT_SENT")
    expect(row["Attempt Outcome"]).toBe("KNOWN_NOT_SENT")
    expect(row["Email"]).toBe("")
    expect(row["Outstanding at Attempt (R)"]).toBe("")
  })
})
