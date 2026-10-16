/** Round 2 probes (no database): the dial.ts rewrite and the argsJson check. */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { callTool, IsaFlowError } from "./client"
import { guardedPost } from "./dial"

let server: Server | null = null
const listen = async (handler: Parameters<typeof createServer>[1]) => {
  server = createServer(handler)
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
afterEach(async () => { const s = server; server = null; if (!s) return; s.closeAllConnections(); await new Promise((r) => s.close(r)) })
const post = (url: string, timeoutMs = 300, headers: Record<string, string> = {}) => guardedPost(`${url}/api/mcp`, { headers: { "content-type": "application/json", ...headers }, body: "{}" }, { timeoutMs })
const uncaught = async (run: () => Promise<void>) => {
  const seen: unknown[] = []
  const saved = process.listeners("uncaughtException")
  process.removeAllListeners("uncaughtException")
  process.on("uncaughtException", (e) => seen.push(e))
  try { await run(); await new Promise((r) => setTimeout(r, 450)) } finally {
    process.removeAllListeners("uncaughtException")
    for (const l of saved) process.on("uncaughtException", l as never)
  }
  return seen.map(String)
}

describe("round 2: dial.ts", () => {
  it("every throwing header shape rejects once and leaves no later uncaught error", async () => {
    const url = await listen((_q, r) => r.end("{}"))
    const seen = await uncaught(async () => {
      for (const authorization of ["Bearer pat_12345678€", "Bearer pat_1234\r\nX-Evil: 1", "Bearer pat_1234\n", "Bearer pat_\u0000abcdefgh"]) {
        await expect(post(url, 150, { authorization })).rejects.toBeInstanceOf(Error)
      }
    })
    expect(seen).toEqual([])
  })

  it("a server that never answers, and one that trickles bytes forever, hit the single deadline", async () => {
    const hang = await listen(() => undefined)
    const t0 = Date.now()
    await expect(post(hang, 250)).rejects.toThrow(/timed out/)
    expect(Date.now() - t0).toBeLessThan(1500)
    { const s = server!; server = null; s.closeAllConnections(); await new Promise((r) => s.close(r)) }
    const trickle = await listen((_q, r) => {
      r.writeHead(200, { "content-type": "application/json" })
      const iv = setInterval(() => r.write(" "), 40)
      r.on("close", () => clearInterval(iv))
    })
    const t1 = Date.now()
    await expect(post(trickle, 300)).rejects.toThrow()
    expect(Date.now() - t1).toBeLessThan(1500)
  })

  it("the 8 MB cap: 8 MB passes, 8 MB + 1 and an endless body are refused, with no uncaught error", async () => {
    const MB8 = 8 * 1024 * 1024
    const url = await listen((q, r) => {
      const n = q.url!.includes("big") ? MB8 + 1 : q.url!.includes("endless") ? Infinity : MB8
      r.writeHead(200)
      let sent = 0
      const pump = () => { while (sent < n) { const ok = r.write(Buffer.alloc(65536, 32)); sent += 65536; if (!ok) return void r.once("drain", pump); if (n === Infinity && sent > MB8 * 3) return } r.end() }
      pump()
    })
    const seen = await uncaught(async () => {
      const exact = await guardedPost(`${url}/api/mcp`, { headers: {}, body: "{}" }, { timeoutMs: 5000 })
      expect((await exact.arrayBuffer()).byteLength).toBeGreaterThanOrEqual(MB8)
      await expect(guardedPost(`${url}/big`, { headers: {}, body: "{}" }, { timeoutMs: 5000 })).rejects.toThrow(/too large/)
      await expect(guardedPost(`${url}/endless`, { headers: {}, body: "{}" }, { timeoutMs: 5000 })).rejects.toThrow()
    })
    expect(seen).toEqual([])
  })

  it("a connection reset mid-body, and a server that closes without answering, reject", async () => {
    const url = await listen((_q, r) => { r.writeHead(200, { "content-length": "100" }); r.write("abc"); setTimeout(() => r.socket?.destroy(), 20) })
    await expect(post(url, 1000)).rejects.toThrow()
    { const s = server!; server = null; s.closeAllConnections(); await new Promise((r) => s.close(r)) }
    const url2 = await listen((q) => q.socket.destroy())
    await expect(post(url2, 1000)).rejects.toThrow()
  })
})

describe("round 2: argsJson must be exactly one JSON object", () => {
  const env = { NODE_ENV: "test", ISAFLOW_ALLOWED_ORIGINS: "http://127.0.0.1:1" } as unknown as NodeJS.ProcessEnv
  const target = { baseUrl: "http://127.0.0.1:1", token: "pat_abcdefgh" }
  it("refuses envelope-breaking and non-object text before any dial", async () => {
    for (const bad of ['{"a":1}},"x":{"y":1', '{}], "method":"x"', "[]", "null", '"s"', "1", "", "{}{}", '{"a":1} {"b":2}', "{'a':1}"]) {
      const e = (await callTool(target, "create_draft_journal", bad, { env }).catch((x: unknown) => x)) as IsaFlowError
      expect(e, bad).toBeInstanceOf(IsaFlowError)
      expect(e.kind, bad).toBe("definite")
      expect(e.message, bad).toMatch(/not one JSON object/)
    }
  })
  it("accepts padded objects and nested members, and splices the text byte for byte", async () => {
    let body = ""
    const fetch = (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } }), { status: 200 }) }) as unknown as typeof globalThis.fetch
    const args = ' {"a":{"b":[1,2]},"__proto__":{"x":1}} '
    await callTool(target, "list_companies", args, { env, fetch })
    expect(body).toContain(`"arguments":${args}}`)
    expect(JSON.parse(body).params).toEqual({ name: "list_companies", arguments: JSON.parse(args) })
  })
})
