import { describe, expect, it } from "vitest"
import { frameOctetCounted, severityOf, toCef, toSiemEvent, toSyslog5424, type SiemSourceRow } from "./format"

const row: SiemSourceRow = {
  id: "ckaudit1", tenantId: "tenant-1", userId: "user-1", userEmail: "ops@lender.invalid", action: "LOAN_STATUS_CHANGED",
  entity: "Loan", entityId: "loan-1", oldValue: { status: "ACTIVE" }, newValue: { status: "SETTLED" }, ipAddress: "10.0.0.7",
  createdAt: new Date("2026-10-29T12:00:00.123Z"), chainSeq: 41, rowHash: "ab".repeat(32), prevHash: "cd".repeat(32),
}

describe("SIEM event formats", () => {
  it("maps the row to the documented fields", () => {
    expect(toSiemEvent(row)).toMatchObject({
      eventId: "ckaudit1", timestamp: "2026-10-29T12:00:00.123Z", action: "LOAN_STATUS_CHANGED", severity: 3,
      actor: { userId: "user-1", email: "ops@lender.invalid" }, sourceIp: "10.0.0.7", entity: "Loan", entityId: "loan-1",
      oldValue: { status: "ACTIVE" }, newValue: { status: "SETTLED" }, chain: { seq: 41, rowHash: "ab".repeat(32) },
    })
  })

  it("writes a CEF line a parser can read back", () => {
    const cef = toCef(toSiemEvent(row))
    expect(cef.startsWith("CEF:0|CredaFlow|CredaFlow LMS|1|LOAN_STATUS_CHANGED|LOAN_STATUS_CHANGED|3|")).toBe(true)
    expect(cef).toContain("externalId=ckaudit1")
    expect(cef).toContain(`rt=${Date.parse("2026-10-29T12:00:00.123Z")}`)
    expect(cef).toContain("suser=ops@lender.invalid")
    expect(cef).toContain("src=10.0.0.7")
    expect(cef).toContain("cn1=41")
    expect(cef).toContain('cs5={"status":"SETTLED"}')
  })

  it("escapes what would break CEF framing: pipes in the header, equals and newlines in the extension", () => {
    const cef = toCef(toSiemEvent({ ...row, action: "A|B", userEmail: "a=b\nc@x.invalid" }))
    expect(cef.split("|")[4]).toBe("A\\")
    expect(cef).toContain("suser=a\\=b\\nc@x.invalid")
    expect(cef).not.toMatch(/\n/)
  })

  it("truncates a long value instead of exceeding the CEF field limit", () => {
    const cef = toCef(toSiemEvent({ ...row, newValue: { blob: "x".repeat(5000) } }))
    expect(cef).toContain("[truncated]")
    expect(cef.length).toBeLessThan(2500)
  })

  it("writes RFC 5424: priority 13*8+severity, version 1, ISO time, structured data, CEF body", () => {
    const msg = toSyslog5424(toSiemEvent(row), "app-1")
    expect(msg).toMatch(/^<110>1 2026-10-29T12:00:00\.123Z app-1 credaflow - LOAN_STATUS_CHANGED \[cf@32473 eventId="ckaudit1" tenant="tenant-1" seq="41" /)
    expect(msg).toContain("] ﻿CEF:0|")
  })

  it("escapes quotes, backslashes and brackets in structured data", () => {
    const msg = toSyslog5424(toSiemEvent({ ...row, userEmail: 'a"b]c\\d@x.invalid' }), "h")
    expect(msg).toContain('user="a\\"b\\]c\\\\d@x.invalid"')
  })

  it("rates failures and denials above routine changes, and a broken chain highest", () => {
    expect(severityOf("SECURITY_LOGIN_FAILED")).toBe(5)
    expect(severityOf("SECURITY_PERMISSION_DENIED")).toBe(5)
    expect(severityOf("AUDIT_CHAIN_BROKEN")).toBe(9)
    expect(toSyslog5424(toSiemEvent({ ...row, action: "AUDIT_CHAIN_BROKEN" }), "h").startsWith("<106>")).toBe(true)
    expect(toSyslog5424(toSiemEvent({ ...row, action: "SECURITY_LOGIN_FAILED" }), "h").startsWith("<108>")).toBe(true)
  })

  it("counts octets, not characters, so a multibyte message is framed whole", () => {
    const framed = frameOctetCounted("héllo")
    expect(framed.toString("utf8")).toBe("6 héllo")
  })
})
