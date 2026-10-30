/**
 * Real-Postgres proof of the TOTP routes: turning your own 2FA off needs a
 * fresh code (a code already used at sign-in, or twice, is refused through
 * lastTotpCounter), is refused while the lender requires 2FA, and leaves an
 * audit row; an enrolled account cannot enrol again; an admin's reset of
 * another user's 2FA clears it and signs them out.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/settings/totp/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient, type UserRole } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_totp_routes_${token}`
const slug = `totp-routes-${token}`
const emailOf = (id: string) => `${id}@test.invalid`

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { DELETE, POST } from "./route"
import { DELETE as RESET } from "../users/[id]/totp/route"
import { generateTotpCode, generateTotpSecret, verifyTotpCode } from "@/lib/totp"
import { claimTotpCounter } from "@/lib/totp-claim"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("staff TOTP routes (real database)", () => {
  const db = new PrismaClient()
  const secret = generateTotpSecret()
  const ids = {
    officer: `user_tr_officer_${token}`,
    fresh: `user_tr_fresh_${token}`,
    forced: `user_tr_forced_${token}`,
    admin: `user_tr_admin_${token}`,
    peer: `user_tr_peer_${token}`,
    target: `user_tr_target_${token}`,
    foreign: `user_tr_foreign_${token}`,
  }
  const sessionOf = (id: string, role: UserRole, extra: Record<string, unknown> = {}) =>
    ({ user: { id, email: emailOf(id), name: null, role, tenantId, totpVerified: true, tokenVersion: 0, ...extra } })
  const request = (method: string, body?: unknown, path = "/api/settings/totp") => new NextRequest(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", "x-tenant-slug": slug }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setPolicy = (requireStaffTotp: boolean) => db.tenantConfig.update({ where: { tenantId }, data: { requireStaffTotp } })
  const stored = (id: string) => db.user.findUniqueOrThrow({
    where: { id }, select: { totpEnabled: true, totpSecret: true, lastTotpCounter: true, tokenVersion: true },
  })
  // A code for a step the user has not signed in with yet.
  const nextCode = (at = Date.now()) => generateTotpCode(secret, at)

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug, name: "Totp Routes Integration Test" } })
    await db.tenantConfig.create({ data: { tenantId, requireStaffTotp: false } })
    const staff = (id: string, role: UserRole, extra: Record<string, unknown> = {}) =>
      ({ id, tenantId, role, email: emailOf(id), name: "Synthetic Staff", password: "not-a-login-credential", ...extra })
    const enrolled = { totpEnabled: true, totpSecret: secret }
    await db.user.createMany({
      data: [
        staff(ids.officer, "CREDIT_OFFICER", enrolled),
        staff(ids.fresh, "CREDIT_OFFICER"),
        staff(ids.forced, "CREDIT_OFFICER"),
        staff(ids.admin, "ADMIN", enrolled),
        staff(ids.peer, "ADMIN", enrolled),
        staff(ids.target, "CREDIT_OFFICER", enrolled),
      ],
    })
  })

  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  describe("turning off your own 2FA", () => {
    it("is refused while the lender requires 2FA, whatever the code", async () => {
      await setPolicy(true)
      h.session = sessionOf(ids.officer, "CREDIT_OFFICER")
      const res = await DELETE(request("DELETE", { code: nextCode() }))
      expect(res.status).toBe(403)
      expect(await stored(ids.officer)).toMatchObject({ totpEnabled: true, totpSecret: secret })
      const policyRefusal = await db.auditLog.findMany({ where: { tenantId, action: "TOTP_CHANGE_REFUSED", userId: ids.officer } })
      expect(policyRefusal.map((r) => r.newValue)).toEqual([{ refused: true, reason: "policy_requires_totp", httpStatus: 403, operation: "disable" }])
      await setPolicy(false)
    })

    it("is refused with no code or a wrong code, and changes nothing", async () => {
      h.session = sessionOf(ids.officer, "CREDIT_OFFICER")
      expect((await DELETE(request("DELETE"))).status).toBe(400)
      const wrong = String((Number(nextCode()) + 7) % 1_000_000).padStart(6, "0")
      expect((await DELETE(request("DELETE", { code: wrong }))).status).toBe(422)
      expect(await stored(ids.officer)).toMatchObject({ totpEnabled: true, totpSecret: secret })
      expect(await db.auditLog.count({ where: { tenantId, action: "TOTP_DISABLED" } })).toBe(0)
      // The wrong code is on record: who, what, why; never the code.
      const refused = await db.auditLog.findMany({ where: { tenantId, action: "TOTP_CHANGE_REFUSED", userId: ids.officer } })
      expect(refused.map((r) => r.newValue)).toContainEqual({ refused: true, reason: "wrong_code", httpStatus: 422, operation: "disable" })
    })

    it("is refused for a code the account already used (replay), and allowed for a newer one", async () => {
      h.session = sessionOf(ids.officer, "CREDIT_OFFICER")
      const now = Date.now()
      // Sign-in claimed the current step's counter.
      await db.user.update({ where: { id: ids.officer }, data: { lastTotpCounter: Math.floor(now / 30_000) } })
      expect((await DELETE(request("DELETE", { code: nextCode(now) }))).status).toBe(422)
      expect(await stored(ids.officer)).toMatchObject({ totpEnabled: true })

      const res = await DELETE(request("DELETE", { code: nextCode(now + 30_000) }))
      expect(res.status).toBe(200)
      // Sessions signed in with a code do not outlive the 2FA that vouched for them.
      expect(await stored(ids.officer)).toMatchObject({ totpEnabled: false, totpSecret: null, tokenVersion: 1 })
      const rows = await db.auditLog.findMany({ where: { tenantId, action: "TOTP_DISABLED" } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: ids.officer, userEmail: emailOf(ids.officer), entityId: ids.officer,
        oldValue: { totpEnabled: true }, newValue: { totpEnabled: false },
      })
      expect(JSON.stringify(rows)).not.toContain(secret)
    })
  })

  describe("enrolling", () => {
    it("enrols a user without 2FA, leaves a session the lender did not force alone, and audits it", async () => {
      h.session = sessionOf(ids.fresh, "CREDIT_OFFICER", { totpVerified: false })
      const code = nextCode()
      const res = await POST(request("POST", { secret, code }))
      expect(await res.json()).toEqual({ ok: true, signInAgain: false })
      const row = await stored(ids.fresh)
      expect(row).toMatchObject({ totpEnabled: true, totpSecret: secret, tokenVersion: 0 })
      // The code that proved the secret is spent: signing in with it again is a
      // replay (sign-in claims counters through claimTotpCounter), the next
      // step's code is not.
      const spent = verifyTotpCode(code, secret)!
      expect(row.lastTotpCounter).toBe(spent)
      expect(await claimTotpCounter(ids.fresh, spent)).toBe(false)
      expect(await claimTotpCounter(ids.fresh, spent + 1)).toBe(true)
      expect(await db.auditLog.count({ where: { tenantId, action: "TOTP_ENROLLED", entityId: ids.fresh } })).toBe(1)
    })

    it("signs out a session held at enrolment", async () => {
      h.session = sessionOf(ids.forced, "CREDIT_OFFICER", { totpVerified: false, totpEnrolmentRequired: true })
      const res = await POST(request("POST", { secret, code: nextCode() }))
      expect(await res.json()).toEqual({ ok: true, signInAgain: true })
      expect(await stored(ids.forced)).toMatchObject({ totpEnabled: true, tokenVersion: 1 })
    })

    it("refuses to replace the secret of an enrolled account without the current code, and keeps the old secret", async () => {
      h.session = sessionOf(ids.admin, "ADMIN")
      const other = generateTotpSecret()
      const noCode = await POST(request("POST", { secret: other, code: generateTotpCode(other) }))
      expect(noCode.status).toBe(409)
      const wrong = await POST(request("POST", { secret: other, code: generateTotpCode(other), currentCode: "000000" }))
      expect(wrong.status).toBe(422)
      expect(await stored(ids.admin)).toMatchObject({ totpSecret: secret, tokenVersion: 0 })
    })

    it("replaces it with the current code (replay-protected): new secret, user signed out, audited without secrets", async () => {
      h.session = sessionOf(ids.peer, "ADMIN")
      const other = generateTotpSecret()
      const now = Date.now()
      await db.user.update({ where: { id: ids.peer }, data: { lastTotpCounter: Math.floor(now / 30_000) } })
      const newCode = generateTotpCode(other)
      const body = (at: number) => ({ secret: other, code: newCode, currentCode: generateTotpCode(secret, at) })
      expect((await POST(request("POST", body(now)))).status).toBe(422) // the counter sign-in used
      expect(await stored(ids.peer)).toMatchObject({ totpSecret: secret })

      const res = await POST(request("POST", body(now + 30_000)))
      expect(await res.json()).toEqual({ ok: true, signInAgain: true })
      const replaced = await stored(ids.peer)
      expect(replaced).toMatchObject({ totpSecret: other, totpEnabled: true, tokenVersion: 1 })
      const spent = verifyTotpCode(newCode, other)!
      expect(replaced.lastTotpCounter).toBe(spent)
      expect(await claimTotpCounter(ids.peer, spent)).toBe(false) // the new secret's code is not reusable at sign-in
      expect(await claimTotpCounter(ids.peer, spent + 1)).toBe(true) // the next step's is
      const rows = await db.auditLog.findMany({ where: { tenantId, action: "TOTP_REPLACED" } })
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain(other)
      expect(JSON.stringify(rows)).not.toContain(secret)
      await db.user.update({ where: { id: ids.peer }, data: { totpSecret: secret, totpEnabled: true, tokenVersion: 0, lastTotpCounter: null } })
    })
  })

  describe("an admin resetting another user's 2FA", () => {
    const reset = (id: string) => RESET(request("DELETE", undefined, `/api/settings/users/${id}/totp`), { params: Promise.resolve({ id }) })

    it("clears the target's 2FA, signs them out, and audits the actor and the target", async () => {
      h.session = sessionOf(ids.admin, "ADMIN")
      const res = await reset(ids.target)
      expect(res.status).toBe(200)
      expect(await stored(ids.target)).toMatchObject({ totpEnabled: false, totpSecret: null, lastTotpCounter: null, tokenVersion: 1 })
      const rows = await db.auditLog.findMany({ where: { tenantId, action: "TOTP_RESET_BY_ADMIN" } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ userId: ids.admin, userEmail: emailOf(ids.admin), entityId: ids.target, oldValue: { totpEnabled: true }, newValue: { totpEnabled: false } })
    })

    it("refuses a peer, yourself, and a session that did not verify TOTP, changing nothing", async () => {
      h.session = sessionOf(ids.admin, "ADMIN")
      expect((await reset(ids.peer)).status).toBe(403)
      expect((await reset(ids.admin)).status).toBe(400)
      h.session = sessionOf(ids.admin, "ADMIN", { totpVerified: false })
      expect((await reset(ids.officer)).status).toBe(403)
      expect(await stored(ids.peer)).toMatchObject({ totpEnabled: true, totpSecret: secret })
      expect(await stored(ids.admin)).toMatchObject({ totpEnabled: true, totpSecret: secret })
    })
  })
})
