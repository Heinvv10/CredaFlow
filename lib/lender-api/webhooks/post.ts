import https from "node:https"
import { isIP } from "node:net"
import { guardedLookup, resolvePublic, systemResolver, type Resolver } from "@/lib/lender-api/webhooks/ssrf"

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
export async function postWebhook(url: string, body: string, headers: Record<string, string>, deps: PostDeps = {}): Promise<PostResult> {
  const resolve = deps.resolve ?? systemResolver
  let target: URL
  try {
    target = new URL(url)
    if (target.protocol !== "https:") return { ok: false, status: null, error: "the URL must use https" }
    const host = target.hostname.replace(/^\[|\]$/g, "")
    if (isIP(host)) await resolvePublic(host, resolve)
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
  }

  return new Promise<PostResult>((done) => {
    const req = https.request(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "CredaFlow-Webhooks/1", ...headers },
      lookup: guardedLookup(resolve) as unknown as typeof import("node:dns").lookup,
      timeout: deps.timeoutMs ?? 10_000,
      agent: false,
    }, (res) => {
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
    req.on("error", (error) => done({ ok: false, status: null, error: error.message }))
    req.end(body)
  })
}
