/**
 * Real-Postgres proof that the bank-sync switch and its audit row commit
 * together: when the audit insert fails, the switch keeps its old value.
 * A mocked transaction cannot show this — only Postgres rolls back.
 *
 * The audit insert is made to fail for real: the acting user id names no User
 * row, so AuditLog_userId_fkey rejects it inside the transaction.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/settings/bank-sync/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_bank_sync_${token}`
const slug = `bank-sync-${token}`
const userId = `user_bank_sync_${token}`
const userEmail = `admin-${token}@test.invalid`

const { requireApiRoleMock } = vi.hoisted(() => ({ requireApiRoleMock: vi.fn() }))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => requireApiRoleMock(),
}))
// withTenantContext binds the session to the request's tenant; next-auth itself
// cannot load outside Next, so the session is this tenant's admin.
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: userId, tenantId } }) }))

import { PATCH } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

function patch(bankSyncEnabled: boolean) {
  return PATCH(new NextRequest("http://localhost/api/settings/bank-sync", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-tenant-slug": slug },
    body: JSON.stringify({ bankSyncEnabled }),
  }))
}

function actAs(id: string) {
  requireApiRoleMock.mockResolvedValue({ user: { id, email: userEmail, totpVerified: true } })
}

suite("PATCH /api/settings/bank-sync — switch and audit commit together", () => {
  const db = new PrismaClient()

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug, name: "Bank Sync Integration Test" } })
    await db.user.create({
      data: {
        id: userId,
        tenantId,
        email: userEmail,
        name: "Integration Admin",
        password: "not-a-login-credential",
        role: "ADMIN",
      },
    })
    await db.tenantConfig.create({ data: { tenantId, bankSyncEnabled: false } })
  })

  beforeEach(async () => {
    await db.tenantConfig.update({ where: { tenantId }, data: { bankSyncEnabled: false } })
    await db.auditLog.deleteMany({ where: { tenantId } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("leaves bankSyncEnabled unchanged when the audit insert fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    actAs(`missing_user_${token}`)

    const response = await patch(true)

    expect(response.status).toBe(500)
    // The failure is the audit FK, not something earlier in the transaction.
    expect(String(error.mock.calls[0]?.[1])).toContain("AuditLog_userId_fkey")
    const config = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } })
    expect(config.bankSyncEnabled).toBe(false)
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
  })

  it("control: with a real user the switch and its audit row both commit", async () => {
    actAs(userId)

    const response = await patch(true)

    expect(response.status).toBe(200)
    const config = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } })
    expect(config.bankSyncEnabled).toBe(true)
    const audits = await db.auditLog.findMany({ where: { tenantId } })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toEqual(expect.objectContaining({
      action: "BANK_SYNC_ENABLED",
      entity: "TenantConfig",
      entityId: tenantId,
      userId,
      oldValue: { bankSyncEnabled: false },
      newValue: { bankSyncEnabled: true },
    }))
  })
})
