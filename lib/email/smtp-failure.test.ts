import { describe, it, expect, afterEach } from "vitest"
import net from "node:net"
import nodemailer from "nodemailer"
import { smtpFailedBeforeConnection } from "./smtp-failure"

// Driven through REAL nodemailer against local fake SMTP servers: the point is
// what the library actually throws in each phase, which a hand-built error
// object cannot prove.

const MSG = { from: "a@example.com", to: "b@example.com", subject: "x", text: "x" }
const servers: net.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

function listen(onConnection: (s: net.Socket) => void): number {
  const server = net.createServer((s) => { s.on("error", () => {}); onConnection(s) }).listen(0)
  servers.push(server)
  return (server.address() as net.AddressInfo).port
}

// A minimal SMTP server that accepts the whole message, then does `afterData`
// instead of replying 250 — the "was it delivered?" case.
function smtpServer(afterData: (s: net.Socket) => void): number {
  return listen((s) => {
    s.write("220 test ESMTP\r\n")
    let inData = false
    s.on("data", (buf) => {
      const t = buf.toString()
      if (inData) { if (t.includes("\r\n.\r\n")) afterData(s); return }
      if (/^EHLO/i.test(t)) s.write("250 test\r\n")
      else if (/^(MAIL|RCPT)/i.test(t)) s.write("250 ok\r\n")
      else if (/^DATA/i.test(t)) { inData = true; s.write("354 go\r\n") }
    })
  })
}

async function failure(opts: Record<string, unknown>): Promise<unknown> {
  try {
    await nodemailer.createTransport({ host: "127.0.0.1", ignoreTLS: true, ...opts }).sendMail(MSG)
  } catch (e) {
    return e
  }
  throw new Error("expected sendMail to fail")
}

async function closedPort(): Promise<number> {
  const s = net.createServer().listen(0)
  const port = (s.address() as net.AddressInfo).port
  await new Promise((r) => s.close(r))
  return port
}

describe("smtpFailedBeforeConnection — nothing was submitted", () => {
  it("a refused TCP connect", async () => {
    expect(smtpFailedBeforeConnection(await failure({ port: await closedPort() }))).toBe(true)
  })

  it("a server that accepts TCP but never greets", async () => {
    const port = listen(() => {})
    expect(smtpFailedBeforeConnection(await failure({ port, greetingTimeout: 300 }))).toBe(true)
  })

  it("an unresolvable host", async () => {
    expect(smtpFailedBeforeConnection(await failure({ host: "no-such-host.invalid", port: 25 }))).toBe(true)
  })

  // Not reproducible locally (a loopback connect never hangs); this is the
  // exact error nodemailer raises from its connection timer, as seen in prod.
  it("nodemailer's connection timeout", () => {
    expect(smtpFailedBeforeConnection(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" }))).toBe(true)
  })
})

describe("smtpFailedBeforeConnection — the message may have been accepted", () => {
  it("a reset after the message body was sent", async () => {
    const port = smtpServer((s) => s.resetAndDestroy())
    expect(smtpFailedBeforeConnection(await failure({ port }))).toBe(false)
  })

  it("a clean close after the message body was sent", async () => {
    const port = smtpServer((s) => s.end())
    expect(smtpFailedBeforeConnection(await failure({ port }))).toBe(false)
  })

  it("silence after the message body was sent (socket timeout)", async () => {
    const port = smtpServer(() => {})
    expect(smtpFailedBeforeConnection(await failure({ port, socketTimeout: 300 }))).toBe(false)
  })

  it("a TLS wrong-version error, whose phase nothing on the error proves", async () => {
    const port = listen((s) => s.write("220 plaintext\r\n"))
    expect(smtpFailedBeforeConnection(await failure({ port, secure: true, ignoreTLS: false }))).toBe(false)
  })

  it("anything that is not an error object", () => {
    expect(smtpFailedBeforeConnection(undefined)).toBe(false)
    expect(smtpFailedBeforeConnection("Connection timeout")).toBe(false)
  })
})
