import https from "node:https"
import { isIP } from "node:net"
import { guardedLookup, resolvePublic, SsrfError, systemResolver, type Resolver } from "@/lib/lender-api/webhooks/ssrf"

export interface PostResult {
  ok: boolean
  status: number | null
  error: string | null
}

export interface PostDeps {
  resolve?: Resolver
  timeoutMs?: number
}

const RESPONSE_BYTES_KEPT = 512

/**
 * POST one webhook body. The connection's DNS lookup is guardedLookup, so the
 * address dialled is one that passed the SSRF check at that moment; an IP
 * literal (which Node never looks up) is checked here first. Redirects are not
 * followed (a 3xx is a failure). Never throws: the outcome is the result.
 */
/**
 * What a refused destination records on the delivery (and so shows the
 * lender): one message whatever the reason. The detail (which address, which
 * DNS answer) is logged server-side only, so the delivery log cannot be used
 * to map what a name resolves to inside the network.
 */
export const REFUSED_DESTINATION = "destination refused: not a public https address"

function refused(url: string, error: unknown): PostResult {
  console.warn("[webhooks] destination refused", { url, reason: error instanceof Error ? error.message : String(error) })
  return { ok: false, status: null, error: REFUSED_DESTINATION }
}

export async function postWebhook(url: string, body: string, headers: Record<string, string>, deps: PostDeps = {}): Promise<PostResult> {
  const resolve = deps.resolve ?? systemResolver
  let target: URL
  try {
    target = new URL(url)
    if (target.protocol !== "https:") return refused(url, new SsrfError("not https"))
    if (target.port !== "" && target.port !== "443") return refused(url, new SsrfError("not port 443"))
    const host = target.hostname.replace(/^\[|\]$/g, "")
    if (isIP(host)) await resolvePublic(host, resolve)
  } catch (error) {
    return refused(url, error)
  }

  const timeoutMs = deps.timeoutMs ?? 10_000
  return new Promise<PostResult>((resolveResult) => {
    let settled = false
    // One deadline for the whole exchange (DNS, connect, TLS, headers, body):
    // the socket's idle timeout alone resets on every byte, so a receiver
    // trickling its answer could hold a cron slot indefinitely.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`timed out after ${timeoutMs} ms`))
      done({ ok: false, status: null, error: `timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    function done(result: PostResult) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolveResult(result)
    }
    const req = https.request(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "CredaFlow-Webhooks/1", ...headers },
      lookup: guardedLookup(resolve) as unknown as typeof import("node:dns").lookup,
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      // Only the status matters: the body is never read past RESPONSE_BYTES_KEPT.
      let kept = 0
      res.on("data", (chunk: Buffer) => {
        kept += chunk.length
        if (kept > RESPONSE_BYTES_KEPT) res.destroy()
      })
      res.on("close", () => {
        const status = res.statusCode ?? null
        const ok = status !== null && status >= 200 && status < 300
        done({ ok, status, error: ok ? null : `HTTP ${status}` })
      })
    })
    req.on("timeout", () => req.destroy(new Error("timed out")))
    req.on("error", (error) => done(error instanceof SsrfError ? refused(url, error) : { ok: false, status: null, error: error.message }))
    req.end(body)
  })
}
