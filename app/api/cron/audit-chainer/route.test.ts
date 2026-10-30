import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const run = vi.fn()
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: (req: Request) => (req.headers.get("x-cron-secret") === "s" ? null : new Response("no", { status: 401 })) }))
vi.mock("@/lib/audit/chainer", () => ({ runChainerFor: (...a: unknown[]) => run(...a) }))

import { GET } from "./route"

const call = (secret = "s") => GET(new NextRequest("http://localhost/api/cron/audit-chainer", { headers: { "x-cron-secret": secret } }))

beforeEach(() => {
  run.mockReset()
  process.env.AUDIT_CHAIN_KEY = "k".repeat(40)
})

describe("GET /api/cron/audit-chainer", () => {
  it("needs the cron secret", async () => {
    expect((await call("wrong")).status).toBe(401)
    expect(run).not.toHaveBeenCalled()
  })

  it("runs the chainer for most of the minute, every 5 seconds", async () => {
    run.mockResolvedValue({ chains: 2, linked: 9, busy: 0 })
    const res = await call()
    expect(run).toHaveBeenCalledWith(50_000, 5_000)
    expect(await res.json()).toMatchObject({ ok: true, linked: 9 })
  })

  it("answers 503 without the chain key, since an unkeyed chain proves nothing", async () => {
    delete process.env.AUDIT_CHAIN_KEY
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect((await call()).status).toBe(503)
    expect(run).not.toHaveBeenCalled()
  })
})
