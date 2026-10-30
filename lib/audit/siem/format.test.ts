import { describe, expect, it } from "vitest"
import { frameOctetCounted, severityOf, toCef, toSiemEvent, toSyslog5424, type SiemSourceRow } from "./format"

const row: SiemSourceRow = {
  id: "ckaudit1", tenantId: "tenant-1", userId: "user-1", action: "LOAN_STATUS_CHANGED",
  entity: "Loan", entityId: "loan-1", oldValue: { status: "ACTIVE" }, newValue: { status: "SETTLED" }, ipAddress: "10.0.0.7",
  createdAt: new Date("2026-10-29T12:00:00.123Z"), chainSeq: 41, rowHash: "ab".repeat(32), prevHash: "cd".repeat(32),
}

describe("SIEM event formats", () => {
  it("maps the row to the documented fields and sends no values for an ordinary action", () => {
    expect(toSiemEvent(row)).toMatchObject({
      eventId: "ckaudit1", timestamp: "2026-10-29T12:00:00.123Z", action: "LOAN_STATUS_CHANGED", severity: 3,
      actor: { userId: "user-1" }, sourceIp: null, entity: "Loan", entityId: "loan-1",
      oldValue: null, newValue: null, chain: { seq: 41, rowHash: "ab".repeat(32) },
    })
  })

  it("sends masked values and the source address for a security or configuration action", () => {
    const e = toSiemEvent({ ...row, action: "USER_UPDATED", oldValue: { role: "READONLY" }, newValue: { role: "ADMIN", idNumber: "8001015009087" } })
    expect(e.sourceIp).toBe("10.0.0.7")
    expect(e.oldValue).toEqual({ role: "READONLY" })
    expect(e.newValue).toEqual({ role: "ADMIN", idNumber: "[masked]" })
  })

  it("writes a CEF line a parser can read back", () => {
    const cef = toCef(toSiemEvent({ ...row, action: "LOAN_STATUS_CHANGED" }))
    expect(cef.startsWith("CEF:0|CredaFlow|CredaFlow LMS|1|LOAN_STATUS_CHANGED|LOAN_STATUS_CHANGED|3|")).toBe(true)
    expect(cef).toContain("externalId=ckaudit1")
    expect(cef).toContain(`rt=${Date.parse("2026-10-29T12:00:00.123Z")}`)
    expect(cef).not.toContain("suser=")
    expect(cef).toContain("suid=user-1")
    expect(cef).not.toContain("src=")
    expect(cef).toContain("cn1=41")
    expect(cef).not.toContain("cs5=")
  })

  it("escapes what would break CEF framing: backslash and pipe in the header, backslash, equals, CR and LF in the extension", () => {
    const cef = toCef(toSiemEvent({ ...row, action: "A|B\\C\r\nD", userId: "a=b\nc\\d\re" }))
    expect(cef.split(/(?<!\\)\|/)[4]).toBe("A\\|B\\\\C D")
    expect(cef).toContain("suid=a\\=b\\nc\\\\d\\re")
    expect(cef).not.toMatch(/[\r\n]/)
  })

  it("truncates a long value instead of exceeding the CEF field limit", () => {
    const cef = toCef(toSiemEvent({ ...row, action: "USER_UPDATED", newValue: { note: "x".repeat(5000) } }))
    expect(cef).toContain("...")
    expect(cef.length).toBeLessThan(2500)
  })

  it("writes RFC 5424: priority 13*8+severity, version 1, ISO time, structured data, CEF body", () => {
    const msg = toSyslog5424(toSiemEvent(row), "app-1")
    expect(msg).toMatch(/^<110>1 2026-10-29T12:00:00\.123Z app-1 credaflow - LOAN_STATUS_CHANGED \[cf@32473 eventId="ckaudit1" tenant="tenant-1" seq="41" /)
    process.env.AUDIT_SYSLOG_PEN = "55555"
    try {
      expect(toSyslog5424(toSiemEvent(row), "app-1")).toContain("[cf@55555 ")
      process.env.AUDIT_SYSLOG_PEN = "not-a-number"
      expect(toSyslog5424(toSiemEvent(row), "app-1")).toContain("[cf@32473 ")
    } finally {
      delete process.env.AUDIT_SYSLOG_PEN
    }
    expect(msg).toContain("] ﻿CEF:0|")
  })

  it("makes the MSGID the action, printable ASCII without spaces, at most 32 characters", () => {
    const msgid = (action: string) => toSyslog5424(toSiemEvent({ ...row, action }), "h").split(" ")[5]
    expect(msgid("SECURITY_LOGIN_FAILED")).toBe("SECURITY_LOGIN_FAILED")
    expect(msgid("A B\u00e9\tC")).toBe("A_B__C")
    expect(msgid("X".repeat(80))).toHaveLength(32)
  })

  it("escapes quotes, backslashes and brackets in structured data", () => {
    const msg = toSyslog5424(toSiemEvent({ ...row, userId: 'a"b]c\\d' }), "h")
    expect(msg).toContain('userId="a\\"b\\]c\\\\d"')
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
