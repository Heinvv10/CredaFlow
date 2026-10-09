import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getTenantFromRequest: vi.fn(), findUnique: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: mocks.getTenantFromRequest }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => (await import("@/lib/config/__fixtures__/lender-identity")).ACME_LENDER }))
vi.mock("@/lib/prisma", () => ({ prisma: { commsSettings: { findUnique: mocks.findUnique } } }))

import { GET } from "./route"
import type { NextRequest } from "next/server"

const call = () => GET({ headers: new Headers() } as unknown as NextRequest)

describe("website chat status", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.WEBSITE_CHAT_SECRET, proxy: process.env.TRUSTED_PROXY }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
    process.env.WEBSITE_CHAT_SECRET = "s".repeat(40)
    process.env.TRUSTED_PROXY = "1"
    mocks.getTenantFromRequest.mockResolvedValue({ id: "tenant-1" })
    mocks.findUnique.mockResolvedValue({ botsEnabled: true })
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["WEBSITE_CHAT_SECRET", saved.secret], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("is enabled when configured and bots are on", async () => {
    expect(await (await call()).json()).toEqual({ enabled: true })
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" }, select: { botsEnabled: true } })
  })

  it("is enabled (schema default) when the settings row is missing", async () => {
    mocks.findUnique.mockResolvedValue(null)
    expect(await (await call()).json()).toEqual({ enabled: true })
  })

  it("sets a 60s public cache header on every response", async () => {
    const expected = "public, max-age=60"
    expect((await call()).headers.get("Cache-Control")).toBe(expected)
    delete process.env.ANTHROPIC_API_KEY
    expect((await call()).headers.get("Cache-Control")).toBe(expected)
    process.env.ANTHROPIC_API_KEY = "test-key"
    mocks.findUnique.mockRejectedValue(new Error("db down"))
    expect((await call()).headers.get("Cache-Control")).toBe(expected)
  })

  it("is disabled when not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(await (await call()).json()).toEqual({ enabled: false })
  })

  it("is disabled without TRUSTED_PROXY, since the start route's per-IP limits need a real IP", async () => {
    delete process.env.TRUSTED_PROXY
    expect(await (await call()).json()).toEqual({ enabled: false })
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it("is disabled when botsEnabled is false", async () => {
    mocks.findUnique.mockResolvedValue({ botsEnabled: false })
    expect(await (await call()).json()).toEqual({ enabled: false })
  })

  it("is disabled, not a 500, when a dependency throws", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db down"))
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })
})
