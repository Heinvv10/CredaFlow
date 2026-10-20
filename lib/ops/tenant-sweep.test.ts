import { beforeEach, describe, expect, it, vi } from "vitest"

const findMany = vi.hoisted(() => vi.fn())
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findMany } } }))

import { getCurrentTenantId } from "@/lib/tenant-scope"
import { sweepActiveTenants, sweepStatus, tenantFailureDetail } from "./tenant-sweep"

beforeEach(() => {
  findMany.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("sweepActiveTenants", () => {
  it("reads only ACTIVE tenants, in a stable order", async () => {
    findMany.mockResolvedValue([])
    await sweepActiveTenants("t", async () => 1)
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" }, orderBy: { id: "asc" } }))
  })

  it("runs the job once per tenant, each inside that tenant's own frame", async () => {
    findMany.mockResolvedValue([{ id: "t_a", name: "A" }, { id: "t_b", name: "B" }])
    const seen: Array<string | null> = []
    const outcomes = await sweepActiveTenants("t", async (tenant) => {
      seen.push(getCurrentTenantId())
      return tenant.name
    })
    expect(seen).toEqual(["t_a", "t_b"])
    expect(outcomes.map((o) => o.ok && o.value)).toEqual(["A", "B"])
    expect(getCurrentTenantId(), "no frame leaks out of the sweep").toBeNull()
  })

  it("a tenant that throws is reported and the tenants after it still run", async () => {
    findMany.mockResolvedValue([{ id: "t_a", name: "A" }, { id: "t_b", name: "B" }, { id: "t_c", name: "C" }])
    const ran: string[] = []
    const outcomes = await sweepActiveTenants("t", async (tenant) => {
      ran.push(tenant.id)
      if (tenant.id === "t_a") throw new Error("identity not configured")
      return tenant.id
    })
    expect(ran).toEqual(["t_a", "t_b", "t_c"])
    expect(outcomes[0]).toMatchObject({ ok: false, error: "identity not configured" })
    expect(outcomes.slice(1).every((o) => o.ok)).toBe(true)
  })

  it("names the failed tenant in its detail line without the cause", () => {
    expect(tenantFailureDetail({ id: "t_a", name: "A" })).toBe("Tenant A (t_a) failed; see the server log")
  })
})

describe("sweepStatus", () => {
  it("is 200 for a clean sweep and for no tenants", () => {
    expect(sweepStatus({ tenants: 3, failedTenants: 0, otherErrors: 0 })).toEqual({ status: 200, partial: false })
    expect(sweepStatus({ tenants: 0, failedTenants: 0, otherErrors: 0 })).toEqual({ status: 200, partial: false })
  })

  it("is a 200 partial while at least one tenant succeeded", () => {
    expect(sweepStatus({ tenants: 3, failedTenants: 2, otherErrors: 0 })).toEqual({ status: 200, partial: true })
  })

  it("is 503 when every tenant failed, or anything else went wrong", () => {
    expect(sweepStatus({ tenants: 2, failedTenants: 2, otherErrors: 0 }).status).toBe(503)
    expect(sweepStatus({ tenants: 2, failedTenants: 0, otherErrors: 1 }).status).toBe(503)
    expect(sweepStatus({ tenants: 3, failedTenants: 1, otherErrors: 1 }).status).toBe(503)
  })
})
