/**
 * Real-Postgres, real-SMTP proof of the signing-OTP email leg, end to end:
 * requestSigningOtp → sendMessage → the tenant's SMTP EmailConfig → nodemailer
 * → the demo simulator's own SMTP sink (scripts/demo/sim/smtp-sink.ts), the
 * transport the demo bake configures through Settings → Email.
 *
 * Pins the environment contract the demo bake broke on (every persona's
 * agreement signing → 502): the signing-OTP template is redactStoredBody, so
 * sendMessage refuses it before any provider unless UNSUB_TOKEN_SECRET is set
 * (assertRedactedSendIsRecoverable), and only DEMO_MODE=true turns a refused
 * send to a .invalid mailbox into a revealed code. scripts/demo/lib.sh
 * (ensure_shared_secrets) and docker-compose.demo-sim.yml supply both.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/signing-otp/email-delivery.integration.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { AuditAction } from "@/lib/audit"
import { runWithTenant } from "@/lib/tenant-scope"
import { requestSigningOtp } from "./request"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_otpmail_${t}`
const DIGEST = "b".repeat(64)
const SINK = path.resolve(__dirname, "../../scripts/demo/sim/smtp-sink.ts")
const TSX = path.resolve(__dirname, "../../node_modules/.bin/tsx")

let sink: ChildProcess | undefined
let mailDir = ""

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("no port"))))
    })
  })
}

function startSink(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SINK], {
      env: { ...process.env, SMTP_SINK_PORT: String(port), SIM_MAIL_DIR: mailDir },
      stdio: ["ignore", "ignore", "pipe"],
    })
    const timer = setTimeout(() => reject(new Error("smtp-sink did not start in 15 s")), 15_000)
    child.once("error", reject)
    child.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) { clearTimeout(timer); resolve(child) }
    })
  })
}

const sunk = () => readdirSync(mailDir).filter((f) => f.endsWith(".eml"))

async function borrower() {
  const email = `signer-${randomUUID().slice(0, 8)}@otp-mail-it.invalid`
  const client = await db.client.create({
    data: { tenantId, idNumber: syntheticSaId(), firstName: "Signer", lastName: "Fixture", email, phone: "0820000000" },
  })
  const contact = await db.contact.create({
    data: { tenantId, status: "CLIENT", firstSeenChannel: "MANUAL", firstSeenContext: "integration-test" },
  })
  await db.contactIdentity.create({ data: { tenantId, contactId: contact.id, channel: "EMAIL", value: email, source: "MANUAL" } })
  return client
}

// The route runs inside withTenantContext; so does this.
const ask = (client: { id: string; email: string }) => runWithTenant(tenantId, () => requestSigningOtp({
  subject: {
    tenantId, clientId: client.id, purpose: "DOCUMENT", subjectId: `doc-${randomUUID().slice(0, 8)}`, documentSha256: DIGEST,
    recipient: { firstName: "Signer", lastName: "Fixture", email: client.email, whatsapp: null },
  },
  channel: "EMAIL", method: "portal", ip: null, actor: {},
}))

async function audited(clientEmail: string) {
  const row = await db.auditLog.findFirst({
    where: { tenantId, action: AuditAction.SIGNING_OTP_REQUESTED },
    orderBy: { createdAt: "desc" },
  })
  const value = (row?.newValue ?? {}) as { deliveryStatus?: string; deliveryError?: string; demoCodeRevealed?: boolean }
  expect(JSON.stringify(row?.newValue)).not.toContain(clientEmail)
  return value
}

suite("signing OTP by email through SMTP (real database, real SMTP sink)", () => {
  beforeAll(async () => {
    mailDir = mkdtempSync(path.join(tmpdir(), "otp-mail-it-"))
    const port = await freePort()
    sink = await startSink(port)
    await db.tenant.create({ data: { id: tenantId, slug: `otpmail-${t}`, name: "Signing OTP mail IT", domain: `otpmail-${t}.signing-otp-it.test` } })
    await db.emailConfig.create({
      data: {
        tenantId, provider: "IMAP_SMTP", fromName: "Signing OTP mail IT", fromAddress: "accounts@otp-mail-it.example",
        smtpHost: "127.0.0.1", smtpPort: port, smtpUser: "sim", smtpPass: "synthetic-sink-password", useTls: false, active: true,
      },
    })
  }, 30_000)
  afterAll(async () => {
    sink?.kill()
    rmSync(mailDir, { recursive: true, force: true })
    await db.$disconnect()
  })
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "integration-test-secret")
    vi.stubEnv("EMAIL_DELIVERY_MODE", "")
    // The sim app's value; the List-Unsubscribe link is built on it.
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3320")
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it("with UNSUB_TOKEN_SECRET set, the code is accepted by the SMTP server and the challenge is ACCEPTED", async () => {
    vi.stubEnv("UNSUB_TOKEN_SECRET", "integration-unsub-secret")
    vi.stubEnv("DEMO_MODE", "")
    const client = await borrower()
    const before = sunk().length

    const result = await ask(client)

    expect(result).toMatchObject({ ok: true })
    const audit = await audited(client.email)
    expect(audit).toMatchObject({ deliveryStatus: "ACCEPTED" })
    expect(audit.deliveryError).toBeUndefined()
    const files = sunk()
    expect(files.length).toBe(before + 1)
    const eml = files.map((f) => readFileSync(path.join(mailDir, f), "utf8")).find((m) => m.includes(client.email))
    expect(eml).toMatch(/Subject: Your Signing OTP mail IT signing code/)
  })

  it("without UNSUB_TOKEN_SECRET the send is refused before SMTP: 502, FAILED, the reason audited", async () => {
    vi.stubEnv("UNSUB_TOKEN_SECRET", "")
    vi.stubEnv("DEMO_MODE", "")
    const client = await borrower()
    const before = sunk().length

    const result = await ask(client)

    expect(result).toEqual({
      ok: false, status: 502, error: "We could not send a code by email. Try another channel or contact your lender.",
    })
    const audit = await audited(client.email)
    expect(audit.deliveryStatus).toBe("FAILED")
    expect(audit.deliveryError).toMatch(/Refusing to send redacted template "signing_otp_email": UNSUB_TOKEN_SECRET is not set/)
    expect(sunk().length).toBe(before)
  })

  it("DEMO_MODE=true reveals the code for a .invalid mailbox even when the send is refused, recorded as SIMULATED", async () => {
    vi.stubEnv("UNSUB_TOKEN_SECRET", "")
    vi.stubEnv("DEMO_MODE", "true")
    const client = await borrower()

    const result = await ask(client)

    expect(result.ok).toBe(true)
    expect(result.ok && result.challenge.demoCode).toMatch(/^\d{6}$/)
    const audit = await audited(client.email)
    expect(audit).toMatchObject({ deliveryStatus: "SIMULATED", demoCodeRevealed: true })
  })
})
