import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"

const fault = vi.hoisted(() => ({ audit: false, beforeWrite: null as null | (() => Promise<void>), sent: vi.fn(), tenantId: "" }))
vi.mock("@/lib/audit", async (original) => {
  const real = await original<typeof import("@/lib/audit")>()
  return { ...real, logAuditStrict: async (...args: Parameters<typeof real.logAuditStrict>) => {
    await real.logAuditStrict(...args)
    if (fault.audit) throw new Error("synthetic audit commit failure")
  } }
})
vi.mock("bcryptjs", async (original) => {
  const real = (await original<typeof import("bcryptjs")>()).default
  return { default: { ...real, hash: async (password: string) => {
    const hash = await real.hash(password, 4)
    await fault.beforeWrite?.()
    return hash
  } } }
})
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return { withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => runWithTenant(fault.tenantId, () => cb({ id: fault.tenantId })) }
})
vi.mock("@/lib/email/service", () => ({ sendEmail: fault.sent }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn() }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ tradingName: "Synthetic Recovery IT" }) }))
vi.mock("@/lib/messaging/flags", () => ({ isPortalForgotNewSendEnabled: () => false }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "203.0.113.22" }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
import { POST as reset } from "./route"
import { POST as forgot } from "../forgot-password/route"
import bcrypt from "bcryptjs"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const suffix = randomUUID().replaceAll("-", "")
const tenantId = `t_recovery_portal_${suffix}`
const email = `client-${suffix}@recovery.invalid`
const otp = "872614"
let clientId = ""
const request = (route: string, body: object) => new NextRequest(`http://localhost/api/portal/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const attempt = () => reset(request("reset-password", { email, otp, password: "Synthetic-Recovered-Password", confirmPassword: "Synthetic-Recovered-Password" }))

suite("portal recovery credential, code and audit commit together", () => {
  beforeEach(async () => {
    fault.audit = false; fault.beforeWrite = null; fault.tenantId = tenantId; fault.sent.mockReset().mockResolvedValue({ ok: true })
    if (!clientId) {
      await db.tenant.create({ data: { id: tenantId, slug: `recovery-${suffix}`, name: "Synthetic Recovery IT" } })
      clientId = (await db.client.create({ data: { tenantId, email, firstName: "Synthetic", lastName: "Recovery", phone: "0820000000", idNumber: syntheticSaId(), portalPassword: "synthetic-old-hash" } })).id
    }
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.clientOtp.deleteMany({ where: { email } })
    await db.client.update({ where: { id: clientId }, data: { portalPassword: "synthetic-old-hash" } })
    await db.clientOtp.create({ data: { email, otp, expiresAt: new Date(Date.now() + 60_000) } })
  })
  afterAll(async () => {
    if (clientId) {
      await db.auditLog.deleteMany({ where: { tenantId } }); await db.clientOtp.deleteMany({ where: { email } }); await db.client.delete({ where: { id: clientId } }); await db.tenant.delete({ where: { id: tenantId } })
    }
    await db.$disconnect()
  })
  it("records code issuance with anonymous request actor and no secret", async () => {
    expect((await forgot(request("forgot-password", { email, turnstileToken: "synthetic" }))).status).toBe(200)
    const codes = await db.clientOtp.findMany({ where: { email } })
    expect(codes).toHaveLength(2)
    const event = await db.auditLog.findFirstOrThrow({ where: { tenantId, entityId: clientId } })
    expect(event).toMatchObject({ action: "CLIENT_UPDATED", userId: null, userEmail: null, ipAddress: "203.0.113.22", newValue: { passwordResetRequested: true } })
    for (const code of codes) expect(JSON.stringify(event)).not.toContain(code.otp)
    expect(fault.sent).toHaveBeenCalledOnce()
  })
  it("rolls code issuance back and sends nothing on audit failure", async () => {
    fault.audit = true
    await expect(forgot(request("forgot-password", { email, turnstileToken: "synthetic" }))).rejects.toThrow("synthetic audit commit failure")
    expect(await db.clientOtp.count({ where: { email } })).toBe(1)
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
    expect(fault.sent).not.toHaveBeenCalled()
  })
  it("rolls password, code consumption and audit back together", async () => {
    fault.audit = true
    await expect(attempt()).rejects.toThrow("synthetic audit commit failure")
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).portalPassword).toBe("synthetic-old-hash")
    expect((await db.clientOtp.findFirstOrThrow({ where: { email } })).used).toBe(false)
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
  })
  it("permits only one concurrent code consumption and one credential-free audit", async () => {
    let arrived = 0; let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    fault.beforeWrite = async () => { if (++arrived === 2) release(); await ready }
    const responses = await Promise.all([attempt(), attempt()])
    expect(responses.map(r => r.status).sort()).toEqual([200, 400])
    fault.beforeWrite = null
    expect((await attempt()).status).toBe(400)
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
    expect(await bcrypt.compare("Synthetic-Recovered-Password", client.portalPassword!)).toBe(true)
    expect((await db.clientOtp.findFirstOrThrow({ where: { email } })).used).toBe(true)
    const events = await db.auditLog.findMany({ where: { tenantId } })
    expect(events).toHaveLength(1)
    expect(events[0].newValue).toMatchObject({ passwordChanged: true, resetCodeConsumed: true, recoveryMethod: "portal_reset_code" })
    expect(JSON.stringify(events)).not.toContain(otp)
    expect(JSON.stringify(events)).not.toContain(client.portalPassword!)
  })
})
