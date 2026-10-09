/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { prisma } from "../prisma"
import {
  runWithTenant,
  withoutTenantScope,
  TenantScopeError,
} from "../tenant-scope"

// Skip the whole file if DATABASE_URL isn't set (CI without DB)
const HAS_DB = !!process.env.DATABASE_URL
const d = HAS_DB ? describe : describe.skip

const STAMP = Date.now()
const SLUG_A = `test-iso-a-${STAMP}`
const SLUG_B = `test-iso-b-${STAMP}`

let tenantA_id = ""
let tenantB_id = ""
let clientA_id = ""
let clientB_id = ""

function uniqueClientPayload(seed: string): any {
  return {
    firstName: `Test-${seed}`,
    lastName: "Iso",
    email: `${seed}-${STAMP}@example.com`,
    idNumber: `${seed}${STAMP}`.slice(0, 20),
    phone: `082${String(STAMP).slice(-7)}`,
  }
}

d("runtime tenant isolation — enforcer end-to-end", () => {
  beforeAll(async () => {
    await withoutTenantScope(async () => {
      const a = await prisma.tenant.create({
        data: { slug: SLUG_A, name: "Test Tenant A", status: "ACTIVE" },
      })
      const b = await prisma.tenant.create({
        data: { slug: SLUG_B, name: "Test Tenant B", status: "ACTIVE" },
      })
      tenantA_id = a.id
      tenantB_id = b.id
    })

    await runWithTenant(tenantA_id, async () => {
      const c = await prisma.client.create({
        data: uniqueClientPayload("alice"),
      })
      clientA_id = c.id
    })

    await runWithTenant(tenantB_id, async () => {
      const c = await prisma.client.create({
        data: uniqueClientPayload("bob"),
      })
      clientB_id = c.id
    })
  })

  afterAll(async () => {
    await withoutTenantScope(async () => {
      // Delete clients before tenants to respect FK constraint
      const ids = [clientA_id, clientB_id].filter(Boolean)
      if (ids.length) {
        await prisma.client.deleteMany({ where: { id: { in: ids } } })
      }
      const tenantIds = [tenantA_id, tenantB_id].filter(Boolean)
      if (tenantIds.length) {
        await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
      }
    })
  })

  it("findMany under tenant A returns only tenant A clients (auto-inject)", async () => {
    const rows = await runWithTenant(tenantA_id, async () =>
      prisma.client.findMany({ where: {} })
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(clientA_id)
    expect(ids).not.toContain(clientB_id)
  })

  it("findMany under tenant B returns only tenant B clients", async () => {
    const rows = await runWithTenant(tenantB_id, async () =>
      prisma.client.findMany({ where: {} })
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(clientB_id)
    expect(ids).not.toContain(clientA_id)
  })

  it("cross-tenant update is blocked (updateMany scoping)", async () => {
    const result = await runWithTenant(tenantA_id, async () =>
      prisma.client.updateMany({
        where: { id: clientB_id },
        data: { firstName: "Hacked" },
      })
    )
    expect(result.count).toBe(0)
    // Confirm B's row was not modified
    const b = await withoutTenantScope(async () =>
      prisma.client.findUnique({ where: { id: clientB_id } })
    )
    expect(b?.firstName).toBe("Test-bob")
  })

  it("throws TenantScopeError when ALS context is missing and where.tenantId is missing", async () => {
    await expect(prisma.client.findMany({ where: {} })).rejects.toThrow(TenantScopeError)
  })

  it("throws cross-tenant-mismatch when explicit where.tenantId differs from ALS", async () => {
    await expect(
      runWithTenant(tenantA_id, async () =>
        prisma.client.findMany({ where: { tenantId: tenantB_id } })
      )
    ).rejects.toThrow(TenantScopeError)
  })

  it("withoutTenantScope allows queries with no where.tenantId through", async () => {
    const rows = await withoutTenantScope(async () => prisma.client.findMany({ where: {} }))
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it("create under tenant A auto-injects tenantId on the new row", async () => {
    const payload = uniqueClientPayload("carol")
    const created = await runWithTenant(tenantA_id, async () =>
      prisma.client.create({ data: payload })
    )
    expect(created.tenantId).toBe(tenantA_id)
    // Cleanup
    await withoutTenantScope(async () => prisma.client.delete({ where: { id: created.id } }))
  })

  it("create throws when explicit data.tenantId conflicts with ALS", async () => {
    const payload = uniqueClientPayload("mismatch")
    await expect(
      runWithTenant(tenantA_id, async () =>
        prisma.client.create({
          data: { ...payload, tenantId: tenantB_id },
        })
      )
    ).rejects.toThrow(TenantScopeError)
  })
})
