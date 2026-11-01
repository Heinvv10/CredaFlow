/**
 * What a proposed product change must satisfy, checked when it is proposed (the route answers these) and again inside the
 * approval (the handler refuses on them). The refusals are the ones the direct product routes always gave.
 */
import type { LoanProduct, Prisma } from "@prisma/client"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import type { Tx } from "@/lib/maker-checker/types"
import { loanProductCreateCapRefusal, loanProductUpdateCapRefusal } from "./interest-cap"
import { MICRO30_PROTECTED_APPLICATION_STATUSES, isMicro30Code, micro30ContractIssues, micro30DecisionTermsChanged } from "./micro30"
import { isNonNcaProductType } from "./product-kind"
import type { ProductFields } from "./product-change"

export interface ProductRefusal {
  status: number
  body: Record<string, unknown> & { error: string }
}

const refuse = (status: number, error: string, more: Record<string, unknown> = {}): ProductRefusal => ({ status, body: { error, ...more } })

/** The LoanProduct columns a product version carries; once a product has a version they change only through one. */
const VERSIONED_PRODUCT_FIELDS = [
  "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel", "initiationFeeModel", "initiationFeePct", "initiationFeeMax", "monthlyServiceFee",
] as const

/** Rates arrive from a form as percent x 0.01, so 0.0225 can come back as 0.022500000000000003: compare numbers in basis points. */
const sameValue = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.round(a * 10_000) === Math.round(b * 10_000) : a === b)

// Codes the client-facing apply pages hardcode (app/(portal)/portal/apply/[product]/page.tsx PRODUCT_KEY_TO_CODE).
const PORTAL_STABLE_PRODUCT_CODES = new Set(["MICRO30", "PERSONAL", "POFUND"])

function contractRefusal(data: ProductFields): ProductRefusal | null {
  const invalidFields = micro30ContractIssues(data)
  if (invalidFields.length === 0) return null
  return refuse(422, "MICRO30 must use the approved fixed 30-day daily-accrual contract with a 5% monthly rate and R69 service fee.", { invalidFields })
}

function typeRefusal(productType: string): ProductRefusal | null {
  if (!isNcaJurisdiction() || !isNonNcaProductType(productType)) return null
  return refuse(422, "This product type is not available to an NCA lender: its documents and credit-type classification need the lender's legal sign-off first.", { invalidFields: ["productType"] })
}

/** A new product: its contract and rate may be written, and its code is free. */
export async function productCreateRefusal(tx: Pick<Tx, "loanProduct">, tenantId: string, data: ProductFields): Promise<ProductRefusal | null> {
  const invalid = contractRefusal(data) ?? typeRefusal(data.productType)
  if (invalid) return invalid
  const cap = await loanProductCreateCapRefusal(tenantId, data)
  if (cap) return { status: 422, body: cap as ProductRefusal["body"] }
  const taken = await tx.loanProduct.findFirst({ where: { tenantId, code: data.code }, select: { id: true } })
  return taken ? refuse(409, `A product with the code ${data.code} already exists.`, { invalidFields: ["code"] }) : null
}

export type UpdateCheck = { refusal: ProductRefusal } | { data: ProductFields }

/**
 * An edit of `before`: what it may do, and the fields as they are to be written. A stable code is pinned to its one value; a
 * field a version carries stays exactly as the version made it (a value within the comparison's width is not a change).
 */
export async function checkProductUpdate(tx: Pick<Tx, "loanApplication" | "productVersion">, tenantId: string, before: LoanProduct, data: ProductFields): Promise<UpdateCheck> {
  const invalid = contractRefusal(data) ?? (before.productType === data.productType ? null : typeRefusal(data.productType))
  if (invalid) return { refusal: invalid }
  // NCA Regulation 42, on a price change or an activation only (lib/product-config/interest-cap.ts).
  const cap = await loanProductUpdateCapRefusal(tenantId, before, data)
  if (cap) return { refusal: { status: 422, body: cap as ProductRefusal["body"] } }

  const beforeCode = before.code.trim().toUpperCase()
  const written: ProductFields = { ...data }
  if (PORTAL_STABLE_PRODUCT_CODES.has(beforeCode)) {
    if (data.code.trim().toUpperCase() !== beforeCode) return { refusal: refuse(422, `${beforeCode} is a stable product code the portal resolves against and cannot be renamed.`) }
    written.code = beforeCode
  }
  // Moving a product into or out of ASSET_FINANCE moves it between the asset-finance deal list and every consumer list
  // (./product-kind.ts). A product with applications keeps its kind, and a portal-stable code is always consumer.
  if ((before.productType === "ASSET_FINANCE") !== (data.productType === "ASSET_FINANCE")) {
    const kindLocked = (reason: string) => ({ refusal: refuse(422, `The product cannot move into or out of Asset finance: ${reason}. Create a new product instead.`) })
    if (PORTAL_STABLE_PRODUCT_CODES.has(beforeCode)) return kindLocked(`${beforeCode} is a stable consumer product code`)
    const applications = await tx.loanApplication.count({ where: { tenantId, productId: before.id } })
    if (applications > 0) return kindLocked(`${applications} application(s) were made under it`)
  }
  if (beforeCode === "MICRO30" && micro30DecisionTermsChanged(before, data)) {
    const inFlight = await micro30InFlight(tx, tenantId, before.id)
    if (inFlight > 0) return { refusal: refuse(409, "MICRO30 pricing cannot change while an open application may depend on the current quote, decision, PASQ, agreement, or signature evidence.", { inFlightApplications: inFlight }) }
  }
  // A product under the product engine changes through a version a second person approves: its limits, price and fees are not
  // edited here. Its type and whether it is the MICRO30 contract product decide which rules bind it, so they do not move either.
  if (await tx.productVersion.count({ where: { tenantId, productId: before.id } }) > 0) {
    const versioned: string[] = VERSIONED_PRODUCT_FIELDS.filter((field) => !sameValue(before[field], data[field]))
    if (before.productType !== data.productType) versioned.push("productType")
    if (isMicro30Code(before.code) !== isMicro30Code(data.code)) versioned.push("code")
    if (versioned.length > 0) {
      return { refusal: refuse(409, "This product has versions: its limits, price and fees change by proposing a new version, which a second person approves (Settings, Product versions).", { code: "PRODUCT_VERSIONED", fields: versioned }) }
    }
    for (const field of VERSIONED_PRODUCT_FIELDS) (written as unknown as Record<string, unknown>)[field] = before[field]
  }
  return { data: written }
}

function micro30InFlight(tx: Pick<Tx, "loanApplication">, tenantId: string, productId: string): Promise<number> {
  return tx.loanApplication.count({ where: { tenantId, productId, status: { in: [...MICRO30_PROTECTED_APPLICATION_STATUSES] } } })
}

export async function productDeactivateRefusal(tx: Pick<Tx, "loanApplication">, tenantId: string, before: LoanProduct): Promise<ProductRefusal | null> {
  if (before.code.trim().toUpperCase() !== "MICRO30") return null
  const inFlight = await micro30InFlight(tx, tenantId, before.id)
  return inFlight > 0 ? refuse(409, "MICRO30 cannot be deactivated while an open application may depend on the current quote, decision, agreement, or signature evidence.", { inFlightApplications: inFlight }) : null
}

/** The row a change is about, locked: a concurrent edit, or an application locking the product, waits for the decision. */
export async function lockProduct(tx: Pick<Prisma.TransactionClient, "$queryRaw"> & Pick<Tx, "loanProduct">, tenantId: string, id: string): Promise<LoanProduct | null> {
  await tx.$queryRaw`SELECT "id" FROM "LoanProduct" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`
  return tx.loanProduct.findFirst({ where: { id, tenantId } })
}
