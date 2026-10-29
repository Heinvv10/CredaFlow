/**
 * The two SIEM transports. Neither follows redirects nor trusts a certificate
 * that does not verify (a lender's own CA can be supplied); both dial only
 * addresses siemLookup admits. Each resolves to an outcome, never throws.
 *
 * Syslog over TLS has no application-level acknowledgement: "sent" means the
 * bytes were written, our FIN was sent and the server closed its side without an
 * error (we wait for the socket to close, so a server that resets on receipt is a
 * failure, not a delivery). HTTPS JSON is acknowledged by a 2xx for the whole
 * batch. Both are at-least-once; the event id (the AuditLog id) is the receiver's
 * de-duplication key.
 *
 * An error is reported as a coarse class (ErrorClass), never the exception text:
 * the text names the addresses the host resolved to, and it is shown to a lender's
 * admin and stored in the outbox. The detail goes to the server log.
 */
import { logger } from "@/lib/observability/logger"
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

export type ErrorClass =
  | "config_invalid" | "destination_refused" | "dns_failed" | "connect_failed" | "tls_failed" | "timeout"
  | "rejected_by_siem" | "unauthorised" | "siem_unavailable" | "send_failed"

export interface SendResult {
  /** The SIEM's own acknowledgement id (a request id header), when its answer carried one. */
  ackId?: string
  ok: boolean
  error: ErrorClass | null
  /** The SIEM rejected this content for good (a 4xx that retrying will not fix): split the batch, then give up on the row. */
  permanent?: boolean
}

export interface TransportDeps {
  resolve?: Resolver
  allowPrivate?: boolean
  timeoutMs?: number
  hostname?: string
}

const TIMEOUT_MS = 10_000
const RESPONSE_BYTES_KEPT = 256

/** The class of a transport exception. The detail is logged here, not returned. */
export function classify(error: unknown): ErrorClass {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ""
  const name = error instanceof Error ? error.name : ""
  const text = error instanceof Error ? error.message : String(error)
  logger.error("[audit-siem] transport error", { name, code, text })
  if (name === "SsrfError") return "destination_refused"
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL)$/.test(code) || /does not resolve/.test(text)) return "dns_failed"
  if (/timed out/.test(text) || code === "ETIMEDOUT") return "timeout"
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_OSSL)/.test(code)) return "tls_failed"
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code)) return "connect_failed"
  return "send_failed"
}

const fail = (error: unknown): SendResult => ({ ok: false, error: classify(error) })

/** HTTP statuses a retry cannot fix and that say the content, not the destination, is the problem. */
const POISON_STATUS = (status: number) => status >= 400 && status < 500 && ![401, 403, 404, 408, 429].includes(status)

export function classifyStatus(status: number): SendResult {
  if (status >= 200 && status < 300) return { ok: true, error: null }
  if (status === 401 || status === 403) return { ok: false, error: "unauthorised" }
  if (POISON_STATUS(status)) return { ok: false, error: "rejected_by_siem", permanent: true }
  return { ok: false, error: status >= 500 || status === 408 || status === 429 ? "siem_unavailable" : "send_failed" }
}

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

/**
 * The acknowledgement id an HTTPS delivery's receipt carries: the SIEM's own request id when its answer has
 * one, otherwise the status and the answer's Date header (every HTTP/1.1 origin server sends one), so a
 * receipt always records something the SIEM said, and the database requires it for HTTPS.
 */
export function ackIdOf(status: number, headers: Record<string, string | string[] | undefined>): string {
  const id = headers["x-request-id"] ?? headers["x-amzn-requestid"]
  if (typeof id === "string" && id.trim() !== "") return id.trim().slice(0, 200)
  const date = headers.date
  return `${status}@${typeof date === "string" && date !== "" ? date.slice(0, 100) : "no-date"}`
}

export async function sendSyslogTls(t: SiemTarget, events: SiemEvent[], deps: TransportDeps = {}): Promise<SendResult> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  const hostname = deps.hostname ?? process.env.HOSTNAME ?? "-"
  if (!t.host || !t.port) return { ok: false, error: "config_invalid" }
  const refused = await literalRefusal(t.host, deps)
  if (refused) return refused
  const payload = Buffer.concat(events.map((e) => frameOctetCounted(toSyslog5424(e, hostname))))
  return new Promise<SendResult>((resolve) => {
    let settled = false
    let socket: tls.TLSSocket | undefined
    const done = (r: SendResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket?.destroy()
      resolve(r)
    }
    const deadline = setTimeout(() => done(fail(`timed out after ${timeoutMs} ms`)), timeoutMs)
    try {
      socket = tls.connect({
        host: t.host!, port: t.port!, ...(isIP(t.host!) ? {} : { servername: t.host! }),
        lookup: siemLookup(deps.resolve, deps.allowPrivate) as unknown as typeof import("node:dns").lookup,
        ...tlsMaterial(t),
      })
    } catch (error) {
      // A malformed certificate or key throws here, before any socket exists: classify it like any other TLS fault.
      done(fail(error))
      return
    }
    let secured = false
    socket.once("secureConnect", () => { secured = true; socket.end(payload) })
    // Delivered only when the connection closes cleanly after our data: an error or reset before that is a failure.
    socket.once("close", (hadError) => done(hadError || !secured ? fail(new Error("connection closed before the data was delivered")) : { ok: true, error: null }))
    socket.once("error", (error) => done(fail(error)))
  })
}

export async function sendHttpsJson(t: SiemTarget, events: SiemEvent[], deps: TransportDeps = {}): Promise<SendResult> {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
  let target: URL
  try {
    target = new URL(t.url ?? "")
  } catch {
    return { ok: false, error: "config_invalid" }
  }
  if (target.protocol !== "https:" || target.username || target.password) return { ok: false, error: "config_invalid" }
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
    let req: ReturnType<typeof https.request> | undefined
    const deadline = setTimeout(() => { req?.destroy(); done(fail(`timed out after ${timeoutMs} ms`)) }, timeoutMs)
    try {
      req = https.request(target, {
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
        const result = classifyStatus(res.statusCode ?? 0)
        done(result.ok ? { ...result, ackId: ackIdOf(res.statusCode ?? 0, res.headers) } : result)
      })
      res.on("error", (error) => done(fail(error)))
    })
    } catch (error) {
      // A malformed certificate or key throws here: classify it like any other TLS fault.
      done(fail(error))
      return
    }
    req.on("error", (error) => done(fail(error)))
    req.end(body)
  })
}

export function sendToSiem(t: SiemTarget, events: SiemEvent[], deps: TransportDeps = {}): Promise<SendResult> {
  return t.transport === "SYSLOG_TLS" ? sendSyslogTls(t, events, deps) : sendHttpsJson(t, events, deps)
}
