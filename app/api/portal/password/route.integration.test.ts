/**
 * Pins the one thing the password-change keep-alive cannot test in isolation:
 * the ORDER of Set-Cookie headers once the real proxy and the real route run
 * under Next. The proxy's Auth.js wrapper re-issues the session cookie with
 * the OLD stamp on every request, and the route then sets the NEW one
 * (lib/client-session-cookie.ts). Browsers apply Set-Cookie in order, so the
 * route's cookie only wins while Next emits it last. A Next upgrade that
 * reverses the order would sign the client out of the session that just changed
 * its password; this suite fails when that happens.
 *
 * Starts `next dev` on a free port (APP_MODE=client, as the portal host runs) on
 * the migrated database, so it needs the same DATABASE_URL as the other suites.
 * `next dev` takes a lock on .next/dev, so it cannot run beside another dev
 * server in the same checkout, and it rewrites tsconfig.json (restored below).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/portal/password/route.integration.test.ts
 */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { decode, encode } from "next-auth/jwt"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"

const SECRET = "route-order-it-secret"
const COOKIE = "authjs.session-token"
const OLD_PASSWORD = "OldPassw0rd!"
const NEW_PASSWORD = "NewPassw0rd!2"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const TSCONFIG = path.join(process.cwd(), "tsconfig.json")
const tsconfigBefore = suite === describe ? readFileSync(TSCONFIG, "utf8") : ""

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function waitUntilUp(base: string, server: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next dev exited early:\n${log()}`)
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`next dev did not come up:\n${log()}`)
}

suite("password change under the real proxy: the route's session cookie is the last one set", () => {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `t_ord_${t}`
  const slug = `ord-${t}`
  let clientId = ""
  let base = ""
  let server: ChildProcess | undefined
  let output = ""

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug, name: "Cookie Order IT", domain: `${slug}.cookie-order-it.test` } })
    const client = await db.client.create({
      data: {
        tenantId, idNumber: syntheticSaId(), firstName: "Cookie", lastName: "Order",
        email: `${t}@client.invalid`, phone: "0820000000", portalPassword: bcrypt.hashSync(OLD_PASSWORD, 4),
      },
    })
    clientId = client.id

    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [path.join(process.cwd(), "node_modules/next/dist/bin/next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
      env: {
        ...process.env,
        APP_MODE: "client",
        NEXT_PUBLIC_TENANT_SLUG: slug,
        AUTH_SECRET: SECRET,
        NEXTAUTH_SECRET: SECRET,
        AUTH_URL: base,
        NEXTAUTH_URL: base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    server.stdout?.on("data", (d: Buffer) => { output += d.toString() })
    server.stderr?.on("data", (d: Buffer) => { output += d.toString() })
    await waitUntilUp(base, server, () => output.slice(-3000))
  }, 150_000)

  afterAll(async () => {
    // The exact child we started, by PID; never a pattern kill.
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      await new Promise((r) => server!.once("exit", r))
    }
    if (readFileSync(TSCONFIG, "utf8") !== tsconfigBefore) writeFileSync(TSCONFIG, tsconfigBefore)
    await db.client.deleteMany({ where: { tenantId } })
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined)
    await db.$disconnect()
  })

  it("ends the response with a session-token Set-Cookie carrying the NEW stamp", async () => {
    const { clientCredentialStamp } = await import("@/lib/client-session")
    const stale = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { portalPassword: true } })
    process.env.AUTH_SECRET = SECRET
    const cookie = await encode({
      token: { id: clientId, role: "CLIENT", tenantId, email: `${t}@client.invalid`, credentialStamp: clientCredentialStamp(clientId, tenantId, stale.portalPassword!) },
      secret: SECRET,
      salt: COOKIE,
    })

    const res = await fetch(`${base}/api/portal/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${COOKIE}=${cookie}` },
      body: JSON.stringify({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
    })
    expect(res.status, output.slice(-2000)).toBe(200)

    const sessionCookies = res.headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE}=`))
    expect(sessionCookies.length).toBeGreaterThan(0)
    const last = sessionCookies[sessionCookies.length - 1].split(";")[0].slice(COOKIE.length + 1)
    const token = await decode({ token: last, secret: SECRET, salt: COOKIE })

    const stored = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { portalPassword: true } })
    expect(stored.portalPassword).not.toBe(stale.portalPassword)
    expect(token?.credentialStamp).toBe(clientCredentialStamp(clientId, tenantId, stored.portalPassword!))
    expect(token?.credentialStamp).not.toBe(clientCredentialStamp(clientId, tenantId, stale.portalPassword!))
  }, 120_000)
})
