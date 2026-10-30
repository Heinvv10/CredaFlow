import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The sign-in rate gate of lib/auth.ts authorize(), against the REAL limiter (memory store): the limit
// is read from the awaited result, so a missed `await` on checkRateLimit turns this red. NextAuth, the
// DB and bcrypt are stubbed.
const h = vi.hoisted(() => ({
  config: null as null | {
    providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>
    callbacks: {
      jwt: (args: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>
      session: (args: { session: { user: Record<string, unknown> }; token: Record<string, unknown> }) => Promise<{ user: Record<string, unknown> }>
    }
  },
  findUser: vi.fn(),
  failures: [] as string[],
  passwordOk: true,
}))

vi.mock("next-auth", () => ({
  default: (config: typeof h.config) => {
    h.config = config
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }
  },
  CredentialsSignin: class extends Error { code = "credentials" },
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (a: unknown) => h.findUser(a),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    tenantConfig: { findUnique: async () => ({ requireStaffTotp: false }) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async (a: { data: { reason: string } }) => { h.failures.push(a.data.reason); return {} } },
  },
}))
vi.mock("bcryptjs", () => ({ default: { compare: async () => h.passwordOk, hash: async () => "hash", hashSync: () => "hash" } }))

import "@/lib/auth"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import * as rateLimit from "@/lib/rate-limit"

function authorize(email: string, ip: string) {
  const request = new Request("https://app.lender.example/api/auth/callback/credentials", {
    headers: { host: "app.lender.example", "user-agent": "vitest", "x-forwarded-for": ip },
  })
  return h.config!.providers[0].authorize({ email, password: "wrong" }, request)
}
const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? "error")

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY", "1")
  _resetRateLimitStore()
  h.findUser.mockReset().mockResolvedValue(null)
  h.failures = []
})
afterEach(() => vi.unstubAllEnvs())

describe("authorize(): sign-in rate gate", () => {
  it("refuses an email after 10 attempts in the window, from any address, and records the refusal", async () => {
    for (let i = 0; i < 10; i++) expect(await code(authorize("target@lender.example", `198.51.100.${i + 1}`))).not.toBe("rate_limited")
    expect(await code(authorize("target@lender.example", "198.51.100.99"))).toBe("rate_limited")
    expect(h.failures).toContain("rate_limited")
    expect(await code(authorize("other@lender.example", "198.51.100.98"))).not.toBe("rate_limited")
  })

  it("refuses an address after 30 attempts against different accounts", async () => {
    for (let i = 0; i < 30; i++) expect(await code(authorize(`user${i}@lender.example`, "203.0.113.50"))).not.toBe("rate_limited")
    expect(await code(authorize("user31@lender.example", "203.0.113.50"))).toBe("rate_limited")
  })

  // Breaker 4 (PR #259): a blocked address must not write a limiter row for each email it makes up.
  it("stops at the address bucket once it refuses: no email or combined key is written for the attempt", async () => {
    for (let i = 0; i < 30; i++) await code(authorize(`user${i}@lender.example`, "203.0.113.51"))
    const spy = vi.spyOn(rateLimit, "checkRateLimit")
    expect(await code(authorize("fresh-made-up@lender.example", "203.0.113.51"))).toBe("rate_limited")
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["login:ip:203.0.113.51"])
    spy.mockRestore()
  })

  // Round 2 (PR #259): an IPv6 subscriber holds a whole /64; the address bucket must not be escapable by rotating inside it.
  it("shares one address budget across every IPv6 address of a /64, and not with another /64", async () => {
    for (let i = 0; i < 30; i++) expect(await code(authorize(`v6user${i}@lender.example`, `2001:db8:aa:bb:${i.toString(16)}::${i + 1}`))).not.toBe("rate_limited")
    expect(await code(authorize("v6user-next@lender.example", "2001:db8:aa:bb:ffff:ffff:ffff:ffff"))).toBe("rate_limited")
    expect(await code(authorize("v6user-other@lender.example", "2001:db8:aa:cc::1"))).not.toBe("rate_limited")
  })
})
