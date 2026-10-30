import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const fault = vi.hoisted(() => ({ audit: false, beforeWrite: null as null | (() => Promise<void>), sent: vi.fn() }))
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
vi.mock("@/lib/email/service", () => ({ sendEmail: fault.sent }))
vi.mock("@/lib/config/identity", () => ({ getLenderBrandName: async () => "Synthetic Recovery IT" }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "203.0.113.21" }))

import { POST as reset } from "./route"
import { POST as forgot } from "../forgot-password/route"
import bcrypt from "bcryptjs"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"
const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const suffix = randomUUID().replaceAll("-", "")
const tenantId = `t_recovery_staff_${suffix}`
const email = `staff-${suffix}@recovery.invalid`
const token = `synthetic-reset-${suffix}`
let userId = ""
const request = (route: string, body: object) => new NextRequest(`http://localhost/api/auth/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const attempt = () => reset(request("reset-password", { token, password: "Synthetic-Recovered-Password" }))

suite("staff recovery state and audit commit together", () => {
  beforeEach(async () => {
    fault.audit = false; fault.beforeWrite = null; fault.sent.mockReset().mockResolvedValue({ ok: true })
    if (!userId) {
      await db.tenant.create({ data: { id: tenantId, slug: `recovery-${suffix}`, name: "Synthetic Recovery IT" } })
      userId = (await db.user.create({ data: { tenantId, email, name: "Synthetic Staff", role: "CREDIT_OFFICER", password: "synthetic-old-hash" } })).id
    }
    await purgeAuditRowsForTest(db, { tenantId })
    await db.user.update({ where: { id: userId }, data: { password: "synthetic-old-hash", active: true, tokenVersion: 0, resetToken: token, resetTokenExp: new Date(Date.now() + 60_000) } })
  })
  afterAll(async () => {
    if (userId) {
      await purgeAuditRowsForTest(db, { tenantId }); await db.user.delete({ where: { id: userId } }); await db.tenant.delete({ where: { id: tenantId } })
    }
    await db.$disconnect()
  })

  it("records credential-free issuance with no authenticated actor, before delivery", async () => {
    expect((await forgot(request("forgot-password", { email }))).status).toBe(200)
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const event = await db.auditLog.findFirstOrThrow({ where: { tenantId, entityId: userId } })
    expect(user.resetToken).not.toBe(token)
    expect(event).toMatchObject({ action: "USER_UPDATED", userId: null, userEmail: null, ipAddress: "203.0.113.21", newValue: { passwordResetRequested: true } })
    expect(JSON.stringify(event)).not.toContain(user.resetToken!)
    expect(fault.sent).toHaveBeenCalledOnce()
  })
  it("rolls token issuance back and sends nothing if the audit transaction fails", async () => {
    fault.audit = true
    await expect(forgot(request("forgot-password", { email }))).rejects.toThrow("synthetic audit commit failure")
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).resetToken).toBe(token)
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
    expect(fault.sent).not.toHaveBeenCalled()
  })
  it("rolls password, token consumption, revocation and audit back together", async () => {
    fault.audit = true
    await expect(attempt()).rejects.toThrow("synthetic audit commit failure")
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(user).toMatchObject({ password: "synthetic-old-hash", resetToken: token, tokenVersion: 0 })
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
  })
  it("consumes a racing token once and records exactly one committed recovery", async () => {
    let arrived = 0; let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    fault.beforeWrite = async () => { if (++arrived === 2) release(); await ready }
    const responses = await Promise.all([attempt(), attempt()])
    expect(responses.map(r => r.status).sort()).toEqual([200, 400])
    fault.beforeWrite = null
    expect((await attempt()).status).toBe(400)
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(user).toMatchObject({ resetToken: null, resetTokenExp: null, tokenVersion: 1 })
    expect(await bcrypt.compare("Synthetic-Recovered-Password", user.password)).toBe(true)
    const events = await db.auditLog.findMany({ where: { tenantId } })
    expect(events).toHaveLength(1)
    expect(events[0].newValue).toMatchObject({ passwordChanged: true, resetTokenConsumed: true, recoveryMethod: "staff_reset_token" })
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(user.password)
  })
})
