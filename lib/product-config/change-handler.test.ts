import { beforeEach, describe, expect, it, vi } from "vitest"

const { logAuditStrict, refusals } = vi.hoisted(() => ({
  logAuditStrict: vi.fn(async () => undefined),
  refusals: { create: null as { status: number; body: { error: string } } | null },
}))
vi.mock("@/lib/audit", () => ({ logAuditStrict, AuditAction: { LOAN_PRODUCT_CREATED: "LOAN_PRODUCT_CREATED", LOAN_PRODUCT_UPDATED: "LOAN_PRODUCT_UPDATED", LOAN_PRODUCT_DEACTIVATED: "LOAN_PRODUCT_DEACTIVATED" } }))
vi.mock("./interest-cap", () => ({ loanProductCreateCapRefusal: vi.fn(async () => refusals.create?.body ?? null), loanProductUpdateCapRefusal: vi.fn(async () => null) }))

import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { loanProductHandler } from "./change-handler"
import { parseLoanProductChange, type ProductFields } from "./product-change"

const fields: ProductFields = {
  code: "SAL1", name: "Salary loan", productType: "PERSONAL", minAmount: 100_000, maxAmount: 900_000, minTermDays: 30, maxTermDays: 360, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05, initiationFeeMax: 0, monthlyServiceFee: 0, active: true,
}
const row = { ...fields, id: "p1", tenantId: "t", nonNcaDefaultInterestMargin: null, nonNcaCollectionFeeCents: null, repaymentStructured: false, createdAt: new Date("2027-01-01T00:00:00Z") }
const context = (payload: never) => ({ tenantId: "t", payload, now: new Date(), checker: { id: "checker", email: "c@x.test", role: "ADMIN" }, request: { id: "cr1", makerId: "maker" } as never })

function tx(over: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    loanProduct: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async ({ data }: { data: object }) => ({ ...row, ...data })),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...row, ...data })),
    },
    loanApplication: { count: vi.fn(async () => 0) },
    productVersion: { count: vi.fn(async () => 0) },
    ...over,
  }
}
const problems = (raw: unknown) => {
  try {
    parseLoanProductChange(raw)
    return []
  } catch (error) {
    return (error as InvalidPayloadError).problems
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  refusals.create = null
})

describe("parseLoanProductChange", () => {
  it("accepts each action, trimmed, and names what is wrong with the rest", () => {
    expect(parseLoanProductChange({ action: "CREATE", reason: "  New product  ", product: { ...fields, code: " SAL1 " } })).toMatchObject({ reason: "New product", product: { code: "SAL1" } })
    expect(parseLoanProductChange({ action: "DEACTIVATE", reason: "Withdrawn", productId: "p1" })).toEqual({ action: "DEACTIVATE", reason: "Withdrawn", productId: "p1" })
    expect(problems({ action: "CREATE", product: fields })).toEqual([expect.stringContaining("payload.reason")])
    expect(problems({ action: "UPDATE", reason: "A reason", product: fields })).toEqual([expect.stringContaining("payload.productId")])
    expect(problems({ action: "CREATE", reason: "A reason", productId: "p1", product: fields })).toEqual([expect.stringContaining("payload.productId")])
    expect(problems({ action: "CREATE", reason: "A reason", product: { ...fields, productType: "MORTGAGE" } })[0]).toContain("productType")
    expect(problems({ action: "CREATE", reason: "A reason", product: { ...fields, maxAmount: 1 } })[0]).toContain("maxAmount")
    expect(problems({ action: "CREATE", reason: "A reason", product: { ...fields, surprise: 1 } })[0]).toContain("surprise")
    expect(problems({ action: "ARCHIVE", reason: "A reason" })[0]).toContain("payload.action")
  })
})

describe("loanProductHandler", () => {
  it("is a two-person change: a LOAN_ADMIN proposes, an ADMIN approves", () => {
    expect(loanProductHandler.makePermission).toBe("manage_product_versions")
    expect(loanProductHandler.approvePermission).toBe("approve_product_versions")
  })

  it("creates on approval, tenant-scoped, audited with who proposed it and why", async () => {
    const t = tx()
    await loanProductHandler.apply(t as never, context({ action: "CREATE", reason: "New product", product: fields } as never))
    expect(t.loanProduct.create).toHaveBeenCalledWith({ data: { ...fields, tenantId: "t" } })
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "LOAN_PRODUCT_CREATED", userId: "checker", newValue: expect.objectContaining({ code: "SAL1", changeRequestId: "cr1", makerId: "maker", reason: "New product" }) }), t)
  })

  it("updates with the row before and after on the audit trail, under a row lock", async () => {
    const t = tx()
    await loanProductHandler.apply(t as never, context({ action: "UPDATE", reason: "Renamed", productId: "p1", product: { ...fields, name: "Renamed" } } as never))
    expect(t.$queryRaw).toHaveBeenCalled()
    expect(t.loanProduct.update).toHaveBeenCalledWith({ where: { id: "p1", tenantId: "t" }, data: { ...fields, name: "Renamed" } })
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "LOAN_PRODUCT_UPDATED", oldValue: expect.objectContaining({ name: "Salary loan" }), newValue: expect.objectContaining({ name: "Renamed", makerId: "maker" }) }), t)
  })

  it("deactivates, audited", async () => {
    const t = tx()
    await loanProductHandler.apply(t as never, context({ action: "DEACTIVATE", reason: "Withdrawn", productId: "p1" } as never))
    expect(t.loanProduct.update).toHaveBeenCalledWith({ where: { id: "p1", tenantId: "t" }, data: { active: false } })
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "LOAN_PRODUCT_DEACTIVATED", oldValue: { active: true } }), t)
  })

  it("re-runs the rules at approval: a code taken since, a rate the cap now refuses, a product gone", async () => {
    const create = { action: "CREATE", reason: "New product", product: fields } as never
    await expect(loanProductHandler.verify!(tx() as never, "t", create)).rejects.toThrow(InvalidPayloadError)
    const free = tx()
    free.loanProduct.findFirst = vi.fn(async () => null) as never
    await expect(loanProductHandler.verify!(free as never, "t", create)).resolves.toBeUndefined()
    refusals.create = { status: 422, body: { error: "above the cap" } }
    await expect(loanProductHandler.verify!(free as never, "t", create)).rejects.toThrow(InvalidPayloadError)
    await expect(loanProductHandler.verify!(free as never, "t", { action: "DEACTIVATE", reason: "Withdrawn", productId: "gone" } as never)).rejects.toThrow(InvalidPayloadError)
  })

  it("will not deactivate what is already inactive, or edit a versioned field past its version", async () => {
    const inactive = tx()
    inactive.loanProduct.findFirst = vi.fn(async () => ({ ...row, active: false })) as never
    await expect(loanProductHandler.verify!(inactive as never, "t", { action: "DEACTIVATE", reason: "Withdrawn", productId: "p1" } as never)).rejects.toThrow("already inactive")
    const versioned = tx({ productVersion: { count: vi.fn(async () => 1) } })
    await expect(loanProductHandler.verify!(versioned as never, "t", { action: "UPDATE", reason: "Reprice", productId: "p1", product: { ...fields, interestRatePm: 0.03 } } as never)).rejects.toThrow("versions")
  })

  it("is stale when anything on the row moved after it was submitted", async () => {
    const t = tx()
    const payload = { action: "UPDATE", reason: "Rename", productId: "p1", product: fields } as never
    const first = await loanProductHandler.baseRef!(t as never, "t", payload)
    t.loanProduct.findFirst = vi.fn(async () => ({ ...row, interestRatePm: 0.03 })) as never
    expect(await loanProductHandler.baseRef!(t as never, "t", payload)).not.toBe(first)
  })
})
