/* eslint-disable @typescript-eslint/no-explicit-any */
// The rewriter accepts the same `any` boundary type as Prisma's $extends
// query signature; tests pass through identity functions typed accordingly.
import { describe, it, expect } from "vitest"
import {
  applyTenantScopeExtension,
  runWithTenant,
  withoutTenantScope,
  TenantScopeError,
} from "../tenant-scope"

describe("tenant-scope — Prisma extension query rewriter", () => {
  it("throws missing-context when ALS is empty and where.tenantId is missing on a scoped model", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      rewrite({
        model: "Loan",
        operation: "findMany",
        args: { where: {} },
        query: async (a: any) => a,
      })
    ).rejects.toThrow(TenantScopeError)
  })

  it("passes through when ALS is empty and where.tenantId is explicit", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await rewrite({
      model: "Loan",
      operation: "findMany",
      args: { where: { tenantId: "tenant-A", status: "ACTIVE" } },
      query: async (a: any) => a,
    })
    expect(result.where.tenantId).toBe("tenant-A")
  })

  it("auto-injects tenantId when ALS is set and where.tenantId is missing", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await runWithTenant("tenant-A", () =>
      rewrite({
        model: "Loan",
        operation: "findMany",
        args: { where: { status: "ACTIVE" } },
        query: async (a: any) => a,
      })
    )
    expect(result.where.tenantId).toBe("tenant-A")
    expect(result.where.status).toBe("ACTIVE")
  })

  it("passes through when ALS tenant matches explicit where.tenantId", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await runWithTenant("tenant-A", () =>
      rewrite({
        model: "Loan",
        operation: "findMany",
        args: { where: { tenantId: "tenant-A" } },
        query: async (a: any) => a,
      })
    )
    expect(result.where.tenantId).toBe("tenant-A")
  })

  it("throws cross-tenant-mismatch when ALS tenant differs from where.tenantId", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      runWithTenant("tenant-A", () =>
        rewrite({
          model: "Loan",
          operation: "findMany",
          args: { where: { tenantId: "tenant-B" } },
          query: async (a: any) => a,
        })
      )
    ).rejects.toThrow(TenantScopeError)
  })

  it("passes through inside withoutTenantScope regardless of where.tenantId", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await withoutTenantScope(() =>
      rewrite({
        model: "Loan",
        operation: "findMany",
        args: { where: {} },
        query: async (a: any) => a,
      })
    )
    expect(result.where).toEqual({})
  })

  it("does not enforce on non-tenant-scoped models (e.g. Tenant)", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await rewrite({
      model: "Tenant",
      operation: "findMany",
      args: { where: {} },
      query: async (a: any) => a,
    })
    expect(result.where).toEqual({})
  })

  it("auto-injects tenantId into data for create operations", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await runWithTenant("tenant-A", () =>
      rewrite({
        model: "Loan",
        operation: "create",
        args: { data: { amount: 1000 } },
        query: async (a: any) => a,
      })
    )
    expect(result.data.tenantId).toBe("tenant-A")
    expect(result.data.amount).toBe(1000)
  })

  it("throws on create when data.tenantId conflicts with ALS", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      runWithTenant("tenant-A", () =>
        rewrite({
          model: "Loan",
          operation: "create",
          args: { data: { tenantId: "tenant-B", amount: 1000 } },
          query: async (a: any) => a,
        })
      )
    ).rejects.toThrow(TenantScopeError)
  })

  it("upsert auto-injects tenantId into both where and create payloads", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await runWithTenant("tenant-A", () =>
      rewrite({
        model: "Loan",
        operation: "upsert",
        args: {
          where: { id: "loan-1" },
          create: { id: "loan-1", amount: 1000 },
          update: { amount: 1500 },
        },
        query: async (a: any) => a,
      })
    )
    expect(result.where.tenantId).toBe("tenant-A")
    expect(result.create.tenantId).toBe("tenant-A")
    // update payload is untouched — it's bounded by where, which is scoped
    expect(result.update.tenantId).toBeUndefined()
  })

  it("upsert throws when create.tenantId conflicts with ALS", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      runWithTenant("tenant-A", () =>
        rewrite({
          model: "Loan",
          operation: "upsert",
          args: {
            where: { id: "loan-1" },
            create: { id: "loan-1", tenantId: "tenant-B", amount: 1000 },
            update: { amount: 1500 },
          },
          query: async (a: any) => a,
        })
      )
    ).rejects.toThrow(TenantScopeError)
  })

  it("update auto-injects tenantId into where when ALS is set", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await runWithTenant("tenant-A", () =>
      rewrite({
        model: "Loan",
        operation: "update",
        args: { where: { id: "loan-1" }, data: { amount: 1500 } },
        query: async (a: any) => a,
      })
    )
    expect(result.where.tenantId).toBe("tenant-A")
  })

  it("delete throws missing-context when no ALS and no where.tenantId", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      rewrite({
        model: "Loan",
        operation: "delete",
        args: { where: { id: "loan-1" } },
        query: async (a: any) => a,
      })
    ).rejects.toThrow(TenantScopeError)
  })

  it("deleteMany throws cross-tenant-mismatch when ALS and where disagree", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      runWithTenant("tenant-A", () =>
        rewrite({
          model: "Loan",
          operation: "deleteMany",
          args: { where: { tenantId: "tenant-B" } },
          query: async (a: any) => a,
        })
      )
    ).rejects.toThrow(TenantScopeError)
  })

  it("createMany array auto-injects tenantId on rows missing it (ALS set)", async () => {
    const rewrite = applyTenantScopeExtension()
    const result = await runWithTenant("tenant-A", () =>
      rewrite({
        model: "Loan",
        operation: "createMany",
        args: { data: [{ amount: 100 }, { amount: 200, tenantId: "tenant-A" }] },
        query: async (a: any) => a,
      })
    )
    expect(result.data[0].tenantId).toBe("tenant-A")
    expect(result.data[1].tenantId).toBe("tenant-A")
  })

  it("createMany array throws when one row has mismatched tenantId", async () => {
    const rewrite = applyTenantScopeExtension()
    await expect(
      runWithTenant("tenant-A", () =>
        rewrite({
          model: "Loan",
          operation: "createMany",
          args: { data: [{ amount: 100 }, { tenantId: "tenant-B", amount: 200 }] },
          query: async (a: any) => a,
        })
      )
    ).rejects.toThrow(TenantScopeError)
  })

  // The insurance book and cross-sell opportunities: a query that forgets its
  // tenant throws instead of reading or writing across lenders.
  describe.each(["InsurancePolicy", "InsuranceClaim", "PremiumPayment", "CrossSellOpportunity"])("%s", (model) => {
    it.each([
      ["findMany", { where: { id: "row-1" } }],
      ["count", { where: {} }],
      ["updateMany", { where: { id: "row-1" }, data: {} }],
      ["create", { data: { id: "row-1" } }],
      ["createMany", { data: [{ id: "row-1" }] }],
    ])("%s with no frame and no tenantId throws missing-context", async (operation, args) => {
      const rewrite = applyTenantScopeExtension()
      await expect(
        rewrite({ model, operation, args, query: async (a: any) => a }),
      ).rejects.toMatchObject({ name: "TenantScopeError", reason: "missing-context", model, operation })
    })

    it("injects the frame's tenant into a query that omits it", async () => {
      const rewrite = applyTenantScopeExtension()
      const result = await runWithTenant("tenant-A", () =>
        rewrite({ model, operation: "findFirst", args: { where: { id: "row-1" } }, query: async (a: any) => a }),
      )
      expect(result.where).toEqual({ id: "row-1", tenantId: "tenant-A" })
    })
  })
})
