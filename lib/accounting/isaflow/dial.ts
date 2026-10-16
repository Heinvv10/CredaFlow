/**
 * The one way a request leaves for IsaFlow. An https connection resolves its
 * host through guardedLookup (lib/lender-api/webhooks/ssrf.ts), so the address
 * that is dialled is one that passed the public-address check at that moment:
 * checking the origin first and letting fetch resolve it again would let an
 * allow-listed name re-point to a private address in between (DNS rebinding).
 * An IP literal is never looked up; assertIsaFlowOrigin checked it already.
 * Plain http is reached only for a listed loopback origin under test or
 * development (./base-url.ts) and dials as given. Redirects are not followed.
 */
import http from "node:http"
import https from "node:https"
import { guardedLookup, systemResolver, type Resolver } from "@/lib/lender-api/webhooks/ssrf"

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const BODYLESS = new Set([204, 205, 304])

export function guardedPost(url: string, init: { headers: Record<string, string>; body: string }, opts: { resolve?: Resolver; timeoutMs: number }): Promise<Response> {
  const target = new URL(url)
  const secure = target.protocol === "https:"
  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const done = (outcome: Response | Error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    // One deadline for the whole exchange: a socket timeout resets on every byte.
    const deadline = setTimeout(() => req.destroy(new Error(`timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs)
    const req = (secure ? https : http).request(target, {
      method: "POST",
      headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
      agent: false,
      ...(secure ? { lookup: guardedLookup(opts.resolve ?? systemResolver) as unknown as typeof import("node:dns").lookup } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) res.destroy(new Error("IsaFlow's answer is too large"))
        else chunks.push(chunk)
      })
      res.on("error", done)
      res.on("close", () => { if (!res.complete) done(new Error("the connection closed before IsaFlow finished answering")) })
      res.on("end", () => {
        const status = res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502
        done(new Response(BODYLESS.has(status) ? null : Buffer.concat(chunks), { status }))
      })
    })
    req.on("error", done)
    req.end(init.body)
  })
}
