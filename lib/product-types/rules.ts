/**
 * What the salary-backed, SME, group and revolving product types require before a loan is approved. The behaviour each ships
 * and what it does not do: lib/product-types/.claude.md. Every other product type returns at once and reads nothing, so an NCA
 * lender's approval path does not change.
 */
import type { prisma } from "@/lib/prisma"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { isNonNcaProductType } from "@/lib/product-config/product-kind"

type Db = Pick<typeof prisma, "applicationProductFacts" | "client" | "loan" | "borrowerGroupMember">

export interface TypedApplication {
  id: string
  clientId: string | null
  productId: string
  loanPurposeCategory: string | null
  product: { productType: string }
}

export interface TypeFacts {
  employerName: string | null
  payrollNumber: string | null
  businessName: string | null
  businessRegistrationNumber: string | null
  annualTurnoverCents: bigint | null
  borrowerGroupId: string | null
}

/** Pure: what a salary-backed application still lacks, or null. */
export function salaryBackedRefusal(facts: TypeFacts | null, employmentStatus: string | null): string | null {
  if (!facts?.employerName || !facts.payrollNumber) return "a salary-backed loan needs the employer and the borrower's payroll number"
  if (employmentStatus !== "EMPLOYED" && employmentStatus !== "PART_TIME") return "a salary-backed loan needs a borrower on a payroll: the client's employment status is not employed"
  return null
}

/** Pure: what an SME application still lacks, or null. */
export function smeRefusal(facts: TypeFacts | null, purpose: string | null): string | null {
  if (!facts?.businessName || !facts.businessRegistrationNumber || !facts.annualTurnoverCents) return "an SME loan needs the business's name, registration number and annual turnover"
  if (purpose !== "BUSINESS") return "an SME loan is for a business purpose: set the loan purpose to Business"
  return null
}

async function groupRefusal(db: Db, tenantId: string, clientId: string, groupId: string | null | undefined): Promise<string | null> {
  if (!groupId) return "a group loan needs the lending group the borrower belongs to"
  const members = await db.borrowerGroupMember.findMany({ where: { tenantId, groupId }, select: { clientId: true } })
  if (members.length < 2) return "a lending group needs at least two members"
  if (!members.some((m) => m.clientId === clientId)) return "the borrower is not a member of that lending group"
  const inArrears = await db.loan.count({ where: { tenantId, clientId: { in: members.map((m) => m.clientId) }, status: "ACTIVE", daysInArrears: { gt: 0 } } })
  return inArrears > 0 ? `${inArrears} loan(s) of the group's members are in arrears: the group is not lent to until they are cured` : null
}

/** The borrower's limit on a revolving product is its maximum amount: what they still owe on it counts against a new draw. */
async function revolvingRefusal(db: Db, tenantId: string, application: TypedApplication, clientId: string, principalCents: number, limitCents: number): Promise<string | null> {
  const owed = await db.loan.aggregate({ where: { tenantId, clientId, productId: application.productId, status: "ACTIVE" }, _sum: { outstandingPrincipal: true } })
  const drawn = owed._sum.outstandingPrincipal ?? 0
  return drawn + principalCents > limitCents ? `the draw of ${principalCents} cents on top of the ${drawn} cents still owed exceeds the revolving limit of ${limitCents} cents` : null
}

/** Why this application may not be approved on its product's type, or null. `limitCents` is the maximum amount in effect. */
export async function productTypeRefusal(db: Db, tenantId: string, application: TypedApplication, loan: { principalCents: number; limitCents: number }): Promise<string | null> {
  const type = application.product.productType
  if (!isNonNcaProductType(type)) return null
  if (isNcaJurisdiction()) return "this product type is not available to an NCA lender"
  if (!application.clientId) return "this product type lends to a person: the application has no client"
  const facts = await db.applicationProductFacts.findFirst({ where: { tenantId, applicationId: application.id } })
  if (type === "SALARY_BACKED") {
    const client = await db.client.findFirst({ where: { tenantId, id: application.clientId }, select: { employmentStatus: true } })
    return salaryBackedRefusal(facts, client?.employmentStatus ?? null)
  }
  if (type === "SME") return smeRefusal(facts, application.loanPurposeCategory)
  if (type === "GROUP") return groupRefusal(db, tenantId, application.clientId, facts?.borrowerGroupId)
  return revolvingRefusal(db, tenantId, application, application.clientId, loan.principalCents, loan.limitCents)
}
