import { describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { CONSUMER_PRODUCT_WHERE, CUSTOMER_PRODUCT_WHERE, NON_NCA_PRODUCT_TYPES } from "@/lib/product-config/product-kind"
import { productTypeRefusal, salaryBackedRefusal, smeRefusal, type TypeFacts } from "./rules"

const none: TypeFacts = { employerName: null, payrollNumber: null, businessName: null, businessRegistrationNumber: null, annualTurnoverCents: null, borrowerGroupId: null }
const application = (productType: string, over: Record<string, unknown> = {}) => ({ id: "a1", clientId: "c1", productId: "p1", loanPurposeCategory: null, product: { productType }, ...over })
const loan = { principalCents: 100_000, limitCents: 500_000 }

function db(over: { facts?: TypeFacts | null; employment?: string | null; members?: string[]; arrears?: number; owed?: number | null } = {}) {
  return {
    applicationProductFacts: { findFirst: vi.fn(async () => over.facts ?? null) },
    client: { findFirst: vi.fn(async () => ({ employmentStatus: over.employment ?? "EMPLOYED" })) },
    borrowerGroupMember: { findMany: vi.fn(async () => (over.members ?? []).map((clientId) => ({ clientId }))) },
    loan: { count: vi.fn(async () => over.arrears ?? 0), aggregate: vi.fn(async () => ({ _sum: { outstandingPrincipal: over.owed ?? null } })) },
  } as never
}
const lesotho = () => setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })

describe("where the new types are offered", () => {
  it("no customer channel offers one; staff still see them", () => {
    for (const type of NON_NCA_PRODUCT_TYPES) {
      expect(CUSTOMER_PRODUCT_WHERE.productType.notIn).toContain(type)
      expect(CONSUMER_PRODUCT_WHERE.productType.not).not.toBe(type)
    }
    expect(CUSTOMER_PRODUCT_WHERE.productType.notIn).toContain("ASSET_FINANCE")
    expect(CUSTOMER_PRODUCT_WHERE.repaymentStructured).toBe(false)
  })
})

describe("productTypeRefusal", () => {
  it("reads nothing and refuses nothing for an existing product type, in any jurisdiction", async () => {
    const reads = db()
    expect(await productTypeRefusal(reads, "t", application("PERSONAL"), loan)).toBeNull()
    expect((reads as unknown as { applicationProductFacts: { findFirst: ReturnType<typeof vi.fn> } }).applicationProductFacts.findFirst).not.toHaveBeenCalled()
  })

  it("refuses every new type to an NCA lender, whatever its facts", async () => {
    resetActiveJurisdiction()
    for (const type of ["SALARY_BACKED", "SME", "GROUP", "REVOLVING"]) expect(await productTypeRefusal(db(), "t", application(type), loan)).toContain("NCA lender")
  })

  it("salary-backed: the employer, the payroll number and a borrower on a payroll", async () => {
    lesotho()
    const facts = { ...none, employerName: "Acme Mining", payrollNumber: "P1" }
    expect(await productTypeRefusal(db(), "t", application("SALARY_BACKED"), loan)).toContain("employer")
    expect(await productTypeRefusal(db({ facts, employment: "SELF_EMPLOYED" }), "t", application("SALARY_BACKED"), loan)).toContain("not employed")
    expect(await productTypeRefusal(db({ facts }), "t", application("SALARY_BACKED"), loan)).toBeNull()
    expect(salaryBackedRefusal({ ...facts, payrollNumber: null }, "EMPLOYED")).toContain("payroll")
  })

  it("SME: the business's facts and a business purpose", async () => {
    lesotho()
    const facts = { ...none, businessName: "Acme Traders", businessRegistrationNumber: "2020/1", annualTurnoverCents: BigInt(1) }
    expect(await productTypeRefusal(db(), "t", application("SME"), loan)).toContain("business's name")
    expect(await productTypeRefusal(db({ facts }), "t", application("SME"), loan)).toContain("business purpose")
    expect(await productTypeRefusal(db({ facts }), "t", application("SME", { loanPurposeCategory: "BUSINESS" }), loan)).toBeNull()
    expect(smeRefusal({ ...facts, annualTurnoverCents: null }, "BUSINESS")).toContain("turnover")
  })

  it("group: a named group of two or more with the borrower in it and nobody in arrears", async () => {
    lesotho()
    const facts = { ...none, borrowerGroupId: "g1" }
    expect(await productTypeRefusal(db(), "t", application("GROUP"), loan)).toContain("lending group")
    expect(await productTypeRefusal(db({ facts, members: ["c1"] }), "t", application("GROUP"), loan)).toContain("two members")
    expect(await productTypeRefusal(db({ facts, members: ["c2", "c3"] }), "t", application("GROUP"), loan)).toContain("not a member")
    expect(await productTypeRefusal(db({ facts, members: ["c1", "c2"], arrears: 1 }), "t", application("GROUP"), loan)).toContain("in arrears")
    expect(await productTypeRefusal(db({ facts, members: ["c1", "c2"] }), "t", application("GROUP"), loan)).toBeNull()
  })

  it("revolving: a draw within the limit passes, repaid principal frees it, one cent over is refused", async () => {
    lesotho()
    expect(await productTypeRefusal(db({ owed: 400_000 }), "t", application("REVOLVING"), loan)).toBeNull()
    expect(await productTypeRefusal(db({ owed: 400_001 }), "t", application("REVOLVING"), loan)).toContain("exceeds the revolving limit")
    expect(await productTypeRefusal(db(), "t", application("REVOLVING"), { principalCents: 500_001, limitCents: 500_000 })).toContain("exceeds")
  })
})
