/**
 * The two SIEM transports. Neither follows redirects nor trusts a certificate
 * that does not verify (a lender's own CA can be supplied); both dial only
 * addresses siemLookup admits. Each resolves to an outcome, never throws.
 *
 * Syslog over TLS has no application-level acknowledgement: "sent" means the
 * bytes were written and the connection closed cleanly. HTTPS JSON is
 * acknowledged by a 2xx for the whole batch. Both are at-least-once; the
 * event id (the AuditLog id) is the receiver's de-duplication key.
 */
import https from "node:https"
import tls from "node:tls"
import type { Resolver } from "@/lib/lender-api/webhooks/ssrf"
import { isIP } from "node:net"
import { resolveSiemHost, siemLookup } from "./destination"
import { frameOctetCounted, type SiemEvent, toSyslog5424 } from "./format"

export interface SiemTarget {
  transport: "SYSLOG_TLS" | "HTTPS_JSON"
  host: string | null
  port: number | null
  url: string | null
  token: string | null
  caCertPem: string | null
  clientCertPem: string | null
  clientKeyPem: string | null
}

export interface SendResult {
  ok: boolean
  error: string | null
}

export interface TransportDeps {
  resolve?: Resolver
  allowPrivate?: boolean
  timeoutMs?: number
  hostname?: string
}

const TIMEOUT_MS = 10_000
const RESPONSE_BYTES_KEPT = 256
const fail = (error: unknown): SendResult => ({ ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })

function tlsMaterial(t: SiemTarget) {
  return {
    ...(t.caCertPem ? { ca: t.caCertPem } : {}),
    ...(t.clientCertPem && t.clientKeyPem ? { cert: t.clientCertPem, key: t.clientKeyPem } : {}),
    minVersion: "TLSv1.2" as const,
    rejectUnauthorized: true,
  }
}

/** Node never looks an IP literal up, so the lookup guard cannot see one: check it first. */
async function literalRefusal(host: string, deps: TransportDeps): Promise<SendResult | null> {
  const bare = host.replace(/^\[|\]$/g, "")
  if (isIP(bare) === 0) return null
  return resolveSiemHost(bare, deps.resolve, deps.allowPrivate).then(() => null, (error: unknown) => fail(error))
}

export async function sendSyslogTls(t: SiemTarget, events: SiemEvent[], deps: TransportDeps = {}): Promise<SendResult> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  const hostname = deps.hostname ?? process.env.HOSTNAME ?? "-"
  if (!t.host || !t.port) return fail("syslog host and port are not configured")
  const refused = await literalRefusal(t.host, deps)
  if (refused) return refused
  const payload = Buffer.concat(events.map((e) => frameOctetCounted(toSyslog5424(e, hostname))))
  return new Promise<SendResult>((resolve) => {
    let settled = false
    const done = (r: SendResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      resolve(r)
    }
    const socket = tls.connect({
      host: t.host!, port: t.port!, ...(isIP(t.host!) ? {} : { servername: t.host! }),
      lookup: siemLookup(deps.resolve, deps.allowPrivate) as unknown as typeof import("node:dns").lookup,
      ...tlsMaterial(t),
    })
    const deadline = setTimeout(() => done(fail(`timed out after ${timeoutMs} ms`)), timeoutMs)
    socket.once("secureConnect", () => {
      socket.end(payload, () => done({ ok: true, error: null }))
    })
    socket.once("error", (error) => done(fail(error)))
  })
}

export async function sendHttpsJson(t: SiemTarget, events: SiemEvent[], deps: TransportDeps = {}): Promise<SendResult> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  let target: URL
  try {
    target = new URL(t.url ?? "")
  } catch {
    return fail("the SIEM URL is not valid")
  }
  if (target.protocol !== "https:" || target.username || target.password) return fail("the SIEM URL must be https with no credentials")
  const refused = await literalRefusal(target.hostname, deps)
  if (refused) return refused
  const body = JSON.stringify({ source: "credaflow", events })
  return new Promise<SendResult>((resolve) => {
    let settled = false
    const done = (r: SendResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(r)
    }
    const req = https.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "CredaFlow-Audit-SIEM/1",
        ...(t.token ? { authorization: `Bearer ${t.token}` } : {}),
      },
      lookup: siemLookup(deps.resolve, deps.allowPrivate) as unknown as typeof import("node:dns").lookup,
      agent: false,
      ...tlsMaterial(t),
    }, (res) => {
      let kept = 0
      res.on("data", (chunk: Buffer) => { kept += chunk.length; if (kept > RESPONSE_BYTES_KEPT) res.destroy() })
      res.on("close", () => {
        const status = res.statusCode ?? 0
        done(status >= 200 && status < 300 ? { ok: true, error: null } : fail(`the SIEM answered HTTP ${status}`))
      })
      res.on("error", (error) => done(fail(error)))
    })
    const deadline = setTimeout(() => { req.destroy(); done(fail(`timed out after ${timeoutMs} ms`)) }, timeoutMs)
    req.on("error", (error) => done(fail(error)))
    req.end(body)
  })
}

export function sendToSiem(t: SiemTarget, events: SiemEvent[], deps: TransportDeps = {}): Promise<SendResult> {
  return t.transport === "SYSLOG_TLS" ? sendSyslogTls(t, events, deps) : sendHttpsJson(t, events, deps)
}
