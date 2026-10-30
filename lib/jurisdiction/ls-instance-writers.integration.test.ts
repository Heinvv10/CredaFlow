/**
 * Real-Postgres proof that the ordinary writers still work on a Lesotho instance:
 * a TenantConfig written with the column defaults (ZA / ZAR) by an upsert, a
 * settings writer and the admin "create tenant" route all end up LS / LSL
 * instead of tripping the instance-jurisdiction guard (round-4 finding: a
 * guard that refused the defaults made most /api/settings writers a 500).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/jurisdiction/ls-instance-writers.integration.test.ts
 */
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { applyTenantLanguages } from "@/lib/i18n/language-settings"
import { createThrowawayDb, type ThrowawayDb } from "./throwaway-db.integration-fixture"

const holder = vi.hoisted(() => ({ db: null as unknown, userId: "" }))
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_t, key) => (holder.db as Record<string | symbol, unknown>)[key] }) }))
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: holder.userId, email: "root@test.invalid", role: "SUPER_ADMIN" } }) }))

import { POST } from "@/app/api/admin/tenants/route"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const LS = { jurisdiction: "LS", currency: "LSL" } as const

suite("ordinary writers on a Lesotho instance (real DB)", () => {
  let fresh: ThrowawayDb

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.db = fresh.db
    process.env.ADMIN_SECRET = "s3cret"
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("a settings writer's upsert inserts a missing config as LS / LSL (language settings)", async () => {
    const t = await createChargesTenant(fresh.db, false)
    await fresh.db.tenantConfig.delete({ where: { tenantId: t.tenantId } })
    const result = await fresh.db.$transaction((tx) => applyTenantLanguages(tx as never, {
      tenantId: t.tenantId, actor: { id: t.userId, email: "ops@test.invalid" },
      input: { enabledLanguages: ["en", "zu"], acknowledgements: { zu: { reviewer: "T. Reviewer", confirmed: true } } },
    }))
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await fresh.db.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject(LS)
  })

  it("POST /api/admin/tenants creates a PROVISIONING lender whose config is LS / LSL", async () => {
    // The audit row needs a real acting user.
    holder.userId = (await createChargesTenant(fresh.db, false)).userId
    const response = await POST(new NextRequest("http://localhost/api/admin/tenants", {
      method: "POST", headers: { "x-admin-secret": "s3cret" }, body: JSON.stringify({ slug: "basotho-two", name: "Basotho Two" }),
    }))
    expect(response.status).toBe(201)
    expect(await fresh.db.tenantConfig.findFirstOrThrow({ where: { tenant: { slug: "basotho-two" } } })).toMatchObject(LS)
  })
})
