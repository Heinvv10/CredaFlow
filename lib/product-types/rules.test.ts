import { describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { CONSUMER_PRODUCT_WHERE, CUSTOMER_PRODUCT_WHERE, NON_NCA_PRODUCT_TYPES } from "@/lib/product-config/product-kind"
import { groupEditedBy, productTypeRefusal, salaryBackedRefusal, smeRefusal, type TypeFacts } from "./rules"

const none: TypeFacts = { employerName: null, payrollNumber: null, businessName: null, businessRegistrationNumber: null, annualTurnoverCents: null, borrowerGroupId: null }
const application = (productType: string, over: Record<string, unknown> = {}) => ({ id: "a1", clientId: "c1", productId: "p1", loanPurposeCategory: null, product: { productType }, ...over })
const loan = { principalCents: 100_000, limitCents: 500_000 }

function db(over: { facts?: TypeFacts | null; employment?: string | null; members?: string[]; arrears?: number; owed?: number | null; pending?: number | null } = {}) {
  return {
    loanApplication: { aggregate: vi.fn(async () => ({ _sum: { appliedAmount: over.pending ?? null } })) },
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

  it("group: a member past arrears counts whatever their days-in-arrears says", async () => {
    lesotho()
    const reads = db({ facts: { ...none, borrowerGroupId: "g1" }, members: ["c1", "c2"] })
    await productTypeRefusal(reads, "t", application("GROUP"), loan)
    const where = (reads as unknown as { loan: { count: ReturnType<typeof vi.fn> } }).loan.count.mock.calls[0]![0].where
    expect(where.OR).toEqual([{ status: "ACTIVE", daysInArrears: { gt: 0 } }, { status: { in: ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF"] } }])
  })

  it("revolving: every unsettled status is counted, and a draw approved and not paid out, this application apart", async () => {
    lesotho()
    expect(await productTypeRefusal(db({ owed: 300_000, pending: 100_001 }), "t", application("REVOLVING"), loan)).toContain("exceeds the revolving limit")
    expect(await productTypeRefusal(db({ owed: 300_000, pending: 100_000 }), "t", application("REVOLVING"), loan)).toBeNull()
    const reads = db()
    await productTypeRefusal(reads, "t", application("REVOLVING"), loan)
    const calls = reads as unknown as { loan: { aggregate: ReturnType<typeof vi.fn> }; loanApplication: { aggregate: ReturnType<typeof vi.fn> } }
    expect(calls.loan.aggregate.mock.calls[0]![0].where.status).toEqual({ notIn: ["COMPLETED", "CANCELLED"] })
    expect(calls.loanApplication.aggregate.mock.calls[0]![0].where).toMatchObject({ status: "APPROVED", id: { not: "a1" }, loan: { is: null } })
  })

  it("revolving: a draw within the limit passes, repaid principal frees it, one cent over is refused", async () => {
    lesotho()
    expect(await productTypeRefusal(db({ owed: 400_000 }), "t", application("REVOLVING"), loan)).toBeNull()
    expect(await productTypeRefusal(db({ owed: 400_001 }), "t", application("REVOLVING"), loan)).toContain("exceeds the revolving limit")
    expect(await productTypeRefusal(db(), "t", application("REVOLVING"), { principalCents: 500_001, limitCents: 500_000 })).toContain("exceeds")
  })
})

describe("groupEditedBy", () => {
  const reads = (group: string | null, rows: number) => ({ applicationProductFacts: { findFirst: vi.fn(async () => (group ? { borrowerGroupId: group } : null)) }, auditLog: { count: vi.fn(async () => rows) } })

  it("is true for whoever created the group or changed its members, and reads that trail by group and person", async () => {
    const edited = reads("g1", 1)
    expect(await groupEditedBy(edited as never, "t", "a1", "u1")).toBe(true)
    expect(edited.auditLog.count.mock.calls[0]![0 as never]).toMatchObject({ where: { entity: "BorrowerGroup", entityId: "g1", userId: "u1", action: { in: ["BORROWER_GROUP_CREATED", "BORROWER_GROUP_MEMBERS_CHANGED"] } } })
    expect(await groupEditedBy(reads("g1", 0) as never, "t", "a1", "u1")).toBe(false)
    expect(await groupEditedBy(reads(null, 1) as never, "t", "a1", "u1")).toBe(false)
  })
})
