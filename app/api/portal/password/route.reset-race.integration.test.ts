/**
 * Real-Postgres proof that a portal password change cannot outlive a password
 * reset that lands while the change is in flight. The route reads the stored
 * hash, spends two bcrypt rounds, then writes the new hash and re-stamps the
 * caller's cookie. A reset written inside that window must win: it exists to
 * end every session, including the one making the change.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/portal/password/route.reset-race.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { encode } from "next-auth/jwt"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"

const SECRET = "reset-race-it-secret"
const COOKIE = "authjs.session-token"
vi.stubEnv("AUTH_SECRET", SECRET)

const { auth, duringHash } = vi.hoisted(() => ({
  auth: vi.fn(),
  duringHash: { run: null as null | (() => Promise<void>) },
}))
vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), AuditAction: { CLIENT_UPDATED: "CLIENT_UPDATED" } }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  callerIp: () => "203.0.113.9",
}))
// The concurrent reset is written while the route hashes the new password:
// after it has read and verified the old hash, before it writes.
vi.mock("bcryptjs", async (importOriginal) => {
  const real = ((await importOriginal()) as { default: typeof import("bcryptjs") }).default
  return {
    default: {
      ...real,
      hash: async (pw: string, rounds: number) => {
        const hashed = await real.hash(pw, rounds)
        if (duringHash.run) await duringHash.run()
        return hashed
      },
    },
  }
})
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    withTenantContext: (_req: unknown, handler: (t: { id: string }) => Promise<unknown>) =>
      runWithTenant(currentTenant, () => handler({ id: currentTenant })),
  }
})

import bcrypt from "bcryptjs"
import { POST } from "./route"
import { clientCredentialStamp } from "@/lib/client-session"

let currentTenant = ""
const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

suite("POST /api/portal/password racing a password reset", () => {
  afterAll(async () => { await db.$disconnect() })

  it("a reset written during the change wins, and the changing session is not re-issued", async () => {
    const t = randomUUID().replaceAll("-", "").slice(0, 16)
    currentTenant = `t_pr_${t}`
    await db.tenant.create({ data: { id: currentTenant, slug: `pr-${t}`, name: "Reset Race IT", domain: `pr-${t}.reset-race-it.test` } })
    const oldHash = await bcrypt.hash("old-password-1", 4)
    const email = `${t}@client.invalid`
    const client = await db.client.create({
      data: { tenantId: currentTenant, idNumber: syntheticSaId(), firstName: "Race", lastName: "Fixture", email, phone: "0820000000", portalPassword: oldHash },
    })
    auth.mockResolvedValue({ user: { id: client.id, email, role: "CLIENT", tenantId: currentTenant } })

    const resetHash = await bcrypt.hash("owner-reset-1", 4)
    duringHash.run = async () => {
      duringHash.run = null
      await db.client.update({ where: { id: client.id }, data: { portalPassword: resetHash } })
    }

    const token = { id: client.id, sub: client.id, role: "CLIENT", tenantId: currentTenant, email, credentialStamp: clientCredentialStamp(client.id, currentTenant, oldHash) }
    const req = new NextRequest("http://localhost/api/portal/password", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${COOKIE}=${await encode({ token, secret: SECRET, salt: COOKIE })}` },
      body: JSON.stringify({ currentPassword: "old-password-1", newPassword: "changed-password-1", confirmPassword: "changed-password-1" }),
    })
    const res = await POST(req)

    const stored = await db.client.findUniqueOrThrow({ where: { id: client.id }, select: { portalPassword: true } })
    expect(stored.portalPassword).toBe(resetHash)
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`))).toBe(false)
  })
})
