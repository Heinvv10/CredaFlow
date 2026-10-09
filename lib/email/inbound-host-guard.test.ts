import { describe, it, expect } from "vitest"
import {
  inboundHostAllowed,
  assertInboundHostAllowed,
  inboundAllowedHosts,
  InboundHostBlockedError,
} from "./inbound-host-guard"

/** Tests pass explicit, partial environments; NodeJS.ProcessEnv requires NODE_ENV. */
const unrestricted = { EMAIL_DELIVERY_MODE: "unrestricted" } as unknown as NodeJS.ProcessEnv
const staging = (hosts?: string) =>
  ({ ...(hosts === undefined ? {} : { EMAIL_INBOUND_ALLOWED_HOSTS: hosts }) }) as unknown as NodeJS.ProcessEnv

describe("inboundHostAllowed", () => {
  it("allows any host in unrestricted mode — production is unaffected", () => {
    expect(inboundHostAllowed("mail.lender.example", unrestricted).allowed).toBe(true)
  })

  it("allows a listed host in restricted mode", () => {
    expect(inboundHostAllowed("imap.mailtrap.io", staging("imap.mailtrap.io")).allowed).toBe(true)
  })

  it("is case- and whitespace-insensitive", () => {
    expect(inboundHostAllowed(" IMAP.Mailtrap.IO ", staging("imap.mailtrap.io, other.test")).allowed).toBe(true)
  })

  it("refuses an unlisted host in restricted mode", () => {
    const d = inboundHostAllowed("mail.lender.example", staging("imap.mailtrap.io"))
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain("EMAIL_INBOUND_ALLOWED_HOSTS")
  })

  it("FAILS CLOSED when the allowlist var is unset in restricted mode", () => {
    const d = inboundHostAllowed("imap.mailtrap.io", staging())
    expect(d.allowed).toBe(false)
  })

  it("FAILS CLOSED when the allowlist var is blank", () => {
    expect(inboundHostAllowed("imap.mailtrap.io", staging("  ,  ")).allowed).toBe(false)
  })

  it("treats a typo'd delivery mode as restricted, like recipient-guard", () => {
    const env = { EMAIL_DELIVERY_MODE: "unresticted" } as unknown as NodeJS.ProcessEnv
    expect(inboundHostAllowed("anything.test", env).allowed).toBe(false)
  })

  it("refuses a null host in restricted mode", () => {
    expect(inboundHostAllowed(null, staging("imap.mailtrap.io")).allowed).toBe(false)
  })

  it("parses the comma list", () => {
    expect(inboundAllowedHosts(staging("a.test, b.test ,,c.test"))).toEqual(["a.test", "b.test", "c.test"])
  })
})

describe("assertInboundHostAllowed", () => {
  it("throws InboundHostBlockedError with the reason", () => {
    expect(() => assertInboundHostAllowed("mail.lender.example", staging("imap.mailtrap.io")))
      .toThrow(InboundHostBlockedError)
  })

  it("does not throw in unrestricted mode", () => {
    expect(() => assertInboundHostAllowed("mail.lender.example", unrestricted)).not.toThrow()
  })
})
