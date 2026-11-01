/**
 * What the salary-backed, SME, group and revolving product types require before a loan is approved. The behaviour each ships
 * and what it does not do: lib/product-types/.claude.md. Every other product type returns at once and reads nothing, so an NCA
 * lender's approval path does not change.
 */
import { AuditAction } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { isNonNcaProductType } from "@/lib/product-config/product-kind"

type Db = Pick<typeof prisma, "applicationProductFacts" | "client" | "loan" | "loanApplication" | "borrowerGroupMember">

/** A loan with nothing left to collect. Every other status, RESTRUCTURED included, still counts against a limit. */
const SETTLED_STATUSES = ["COMPLETED", "CANCELLED"] as const
/** Loans past arrears: whatever their days-in-arrears figure says, the group is not lent to. */
const DELINQUENT_STATUSES = ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF"] as const

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
  const inArrears = await db.loan.count({
    where: { tenantId, clientId: { in: members.map((m) => m.clientId) }, OR: [{ status: "ACTIVE", daysInArrears: { gt: 0 } }, { status: { in: [...DELINQUENT_STATUSES] } }] },
  })
  return inArrears > 0 ? `${inArrears} loan(s) of the group's members are in arrears or written off: the group is not lent to until they are cured` : null
}

/**
 * The borrower's limit on a revolving product is its maximum amount. Against a new draw counts what they still owe across all the lender's
 * revolving products, whatever the loan's status (a defaulted or written-off balance is still owed, the write-off route keeps it), and
 * what is approved and not paid out.
 * Exact only under the client's lock: the locked re-checks in lib/affordability/current-approval.ts, at approval and at payout, hold it.
 */
async function revolvingRefusal(db: Db, tenantId: string, application: Pick<TypedApplication, "id">, clientId: string, principalCents: number, limitCents: number): Promise<string | null> {
  const revolving = { productType: "REVOLVING" as const }
  const owed = await db.loan.aggregate({ where: { tenantId, clientId, product: revolving, status: { notIn: [...SETTLED_STATUSES] } }, _sum: { outstandingPrincipal: true } })
  const pending = await db.loanApplication.aggregate({ where: { tenantId, clientId, product: revolving, status: "APPROVED", id: { not: application.id }, loan: { is: null } }, _sum: { approvedAmount: true } })
  const drawn = (owed._sum.outstandingPrincipal ?? 0) + (pending._sum.approvedAmount ?? 0)
  return drawn + principalCents > limitCents ? `the draw of ${principalCents} cents on top of the ${drawn} cents owed or approved exceeds the revolving limit of ${limitCents} cents` : null
}

/** Whether this person created the application's lending group or changed its members: who is in the group decides whether it is lent to, so they do not approve. */
export async function groupEditedBy(db: Pick<typeof prisma, "applicationProductFacts" | "auditLog">, tenantId: string, applicationId: string, userId: string): Promise<boolean> {
  const facts = await db.applicationProductFacts.findFirst({ where: { tenantId, applicationId }, select: { borrowerGroupId: true } })
  if (!facts?.borrowerGroupId) return false
  return (await db.auditLog.count({ where: { tenantId, entity: "BorrowerGroup", entityId: facts.borrowerGroupId, userId, action: { in: [AuditAction.BORROWER_GROUP_CREATED, AuditAction.BORROWER_GROUP_MEMBERS_CHANGED] } } })) > 0
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
