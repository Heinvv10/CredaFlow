/**
 * Both transports against a real TLS server on this machine's own non-loopback
 * address (loopback is never dialable, by design), with a throwaway CA-less
 * self-signed certificate passed as the lender's CA. Skipped where the machine
 * has no such address or no openssl.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { toSiemEvent, type SiemSourceRow } from "./format"
import { sendHttpsJson, sendSyslogTls, type SiemTarget } from "./transport"

const address = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address
let openssl = true
try { execFileSync("openssl", ["version"], { stdio: "ignore" }) } catch { openssl = false }
const suite = address && openssl ? describe : describe.skip

const event = toSiemEvent({
  id: "ev-1", tenantId: "t1", userId: null, userEmail: "a@b.invalid", action: "X", entity: "E", entityId: null, oldValue: null,
  newValue: { k: "v" }, ipAddress: null, createdAt: new Date("2026-10-29T00:00:00Z"), chainSeq: 1, rowHash: "a".repeat(64), prevHash: "0".repeat(64),
} satisfies SiemSourceRow)

suite("SIEM transports", () => {
  let dir: string
  let cert: string
  let key: string
  const servers: Array<{ close(): void }> = []
  const base: Omit<SiemTarget, "transport" | "host" | "port" | "url"> = { token: "tok", caCertPem: null, clientCertPem: null, clientKeyPem: null }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "siem-tls-"))
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=siem.test",
      "-addext", `subjectAltName=IP:${address}`, "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" })
    cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8")
    key = fs.readFileSync(path.join(dir, "k.pem"), "utf8")
  })
  afterAll(() => {
    servers.forEach((s) => s.close())
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const listen = (server: tls.Server | https.Server | http.Server) =>
    new Promise<number>((resolve) => server.listen(0, address, () => resolve((server.address() as AddressInfo).port)))

  it("delivers RFC 5424 over TLS with octet-counting, and verifies the server certificate", async () => {
    const received: string[] = []
    const server = tls.createServer({ cert, key }, (socket) => { socket.on("data", (d) => received.push(d.toString("utf8"))) })
    servers.push(server)
    const port = await listen(server)
    const target: SiemTarget = { ...base, transport: "SYSLOG_TLS", host: address!, port, url: null, caCertPem: cert }

    expect(await sendSyslogTls(target, [event], { allowPrivate: true, hostname: "app-1" })).toEqual({ ok: true, error: null })
    await new Promise((r) => setTimeout(r, 50))
    const text = received.join("")
    expect(text).toMatch(/^\d+ <110>1 2026-10-29T00:00:00\.000Z app-1 credaflow - X \[cf@32473 eventId="ev-1"/)

    // The same server without the lender's CA is not trusted.
    const untrusted = await sendSyslogTls({ ...target, caCertPem: null }, [event], { allowPrivate: true })
    expect(untrusted.ok).toBe(false)
  })

  it("posts a JSON batch with the bearer token and treats a 2xx as the acknowledgement", async () => {
    let seen: { auth?: string; body?: string } = {}
    let status = 204
    const server = https.createServer({ cert, key }, (req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => { seen = { auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") }; res.statusCode = status; res.end() })
    })
    servers.push(server)
    const port = await listen(server)
    const target: SiemTarget = { ...base, transport: "HTTPS_JSON", host: null, port: null, url: `https://${address}:${port}/ingest`, caCertPem: cert }

    expect(await sendHttpsJson(target, [event], { allowPrivate: true })).toEqual({ ok: true, error: null })
    expect(seen.auth).toBe("Bearer tok")
    expect(JSON.parse(seen.body!)).toMatchObject({ source: "credaflow", events: [{ eventId: "ev-1", action: "X", newValue: { k: "v" } }] })

    status = 503
    expect(await sendHttpsJson(target, [event], { allowPrivate: true })).toEqual({ ok: false, error: "the SIEM answered HTTP 503" })
  })

  it("refuses a private address unless the operator opted in, and never connects", async () => {
    let connected = false
    const server = tls.createServer({ cert, key }, () => { connected = true })
    servers.push(server)
    const port = await listen(server)
    const target: SiemTarget = { ...base, transport: "SYSLOG_TLS", host: address!, port, url: null, caCertPem: cert }
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address!)
    if (!isPrivate) return
    expect((await sendSyslogTls(target, [event], { allowPrivate: false })).ok).toBe(false)
    expect(connected).toBe(false)
  })

  it("refuses an http URL and an unconfigured syslog target without dialling", async () => {
    expect((await sendHttpsJson({ ...base, transport: "HTTPS_JSON", host: null, port: null, url: "http://x.invalid" }, [event])).ok).toBe(false)
    expect((await sendSyslogTls({ ...base, transport: "SYSLOG_TLS", host: null, port: null, url: null }, [event])).ok).toBe(false)
  })
})
