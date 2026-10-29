/**
 * Real-Postgres proof of the lender bootstrap: the tenant and first SUPER_ADMIN
 * land with their audit rows, the one-shot guard holds under concurrency (the
 * row lock, which no mock can exercise), and break-glass resets only an
 * existing SUPER_ADMIN.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run scripts/lender/bootstrap.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it, vi } from "vitest"
import { bootstrapSuperAdmin, BootstrapRefusal } from "./bootstrap-admin"
import { bootstrapTenant } from "./bootstrap-tenant"
import { parseTenantConfig } from "./tenant-config"
import { validFile } from "./tenant-config.test-helpers"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const slug = `lender-it-${randomUUID().slice(0, 8)}`
const domain = `${slug}.example.test`
const email = (n: string) => `${n}-${slug}@staging-lender.example`
const parsed = parseTenantConfig({ ...validFile(), slug, domain })
if (!parsed.ok) throw new Error(parsed.errors.join("; "))
const seed = vi.fn(async () => {})
const admin = (over: Partial<Parameters<typeof bootstrapSuperAdmin>[1]>) =>
  bootstrapSuperAdmin(db, { tenantSlug: slug, email: email("a"), mode: "bootstrap", dryRun: false, operator: "it@host", ...over })

suite("lender bootstrap (real DB)", () => {
  afterAll(async () => {
    const t = await db.tenant.findUnique({ where: { slug } })
    if (t) {
      await purgeAuditRowsForTest(db, { tenantId: t.id })
      await db.user.deleteMany({ where: { tenantId: t.id } })
      await db.tenantConfig.deleteMany({ where: { tenantId: t.id } })
      await db.tenant.delete({ where: { id: t.id } })
    }
    await db.$disconnect()
  })

  it("creates the tenant and config with both audit rows, then a rerun is a no-op", async () => {
    const first = await bootstrapTenant(db, parsed.config, { dryRun: false, operator: "it@host", seedTemplates: seed })
    expect(first.status).toBe("created")
    const again = await bootstrapTenant(db, parsed.config, { dryRun: false, operator: "it@host", seedTemplates: seed })
    expect(again.status).toBe("unchanged")

    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug }, include: { config: true } })
    expect(tenant).toMatchObject({ status: "ACTIVE", domain })
    expect(tenant.config).toMatchObject({ ncrNumber: "NCRCP99999", legalName: "Staging Lender (Pty) Ltd", featureLms: true })
    const audits = await db.auditLog.findMany({ where: { tenantId: tenant.id }, select: { action: true } })
    expect(audits.map((a) => a.action).sort()).toEqual(["LENDER_IDENTITY_UPDATED", "TENANT_CREATED"])
  })

  it("lets exactly one of two concurrent bootstraps win", async () => {
    const results = await Promise.allSettled([admin({ email: email("a") }), admin({ email: email("b") })])
    const won = results.filter((r) => r.status === "fulfilled")
    const lost = results.filter((r) => r.status === "rejected")
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(((lost[0] as PromiseRejectedResult).reason as BootstrapRefusal).code).toBe("SUPER_ADMIN_EXISTS")
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug } })
    expect(await db.user.count({ where: { tenantId: tenant.id, role: "SUPER_ADMIN" } })).toBe(1)
  })

  it("break-glass resets the existing SUPER_ADMIN's password and TOTP, revokes sessions and audits", async () => {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug } })
    const before = await db.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: "SUPER_ADMIN" } })
    await db.user.update({ where: { id: before.id }, data: { active: false } })

    await expect(admin({ email: before.email, mode: "break-glass" })).rejects.toMatchObject({ code: "REACTIVATE_REQUIRED" })
    expect((await db.user.findUniqueOrThrow({ where: { id: before.id } })).active).toBe(false)

    const r = await admin({ email: before.email, mode: "break-glass", reactivate: true })
    if (r.kind !== "reset") throw new Error("unexpected")
    const after = await db.user.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.active).toBe(true)
    expect(after.tokenVersion).toBe(before.tokenVersion + 1)
    expect(await bcrypt.compare(r.password, after.password)).toBe(true)
    expect(after.totpSecret).toBe(r.totpSecret)
    expect(await db.auditLog.count({ where: { tenantId: tenant.id, action: "SUPER_ADMIN_BREAK_GLASS_RESET" } })).toBe(1)
  })
})
