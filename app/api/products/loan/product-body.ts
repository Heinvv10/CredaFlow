import { NextResponse } from "next/server"
import { loanProductBoundsIssues } from "@/lib/product-config/bounds"
import { parseNonNcaArrearsTerms } from "@/lib/product-config/non-nca-arrears"
import { parseRegulatorApprovalRef } from "@/lib/product-config/regulator-approval-ref"
import type { ProductFields } from "@/lib/product-config/product-change"

/** The product form's body (amounts in rand, rates in percent) as stored fields, or the 422 that refuses it. `active` is left to the caller. */
export function productFieldsFromBody(body: Record<string, unknown>): { fields: Omit<ProductFields, "active"> } | { response: NextResponse } {
  const boundsIssues = loanProductBoundsIssues(body as Parameters<typeof loanProductBoundsIssues>[0])
  if (boundsIssues.length > 0) {
    return {
      response: NextResponse.json(
        { error: "Amounts must be positive with a minimum no higher than the maximum, and terms must be whole days with a minimum no higher than the maximum.", invalidFields: boundsIssues },
        { status: 422 },
      ),
    }
  }
  const arrears = parseNonNcaArrearsTerms(body)
  if ("issues" in arrears) {
    return {
      response: NextResponse.json(
        { error: "The NON_NCA arrears terms must be a default-interest margin as an annual decimal from 0 to below 1 (0.02 = 2%) and a collection fee in whole cents, or null.", invalidFields: arrears.issues },
        { status: 422 },
      ),
    }
  }
  const regulator = parseRegulatorApprovalRef(body)
  if ("issues" in regulator) {
    return {
      response: NextResponse.json(
        { error: "The regulator's product approval reference is up to 64 letters, digits and / . - _ or spaces, or null, and a South African (NCA) lender's products carry none.", invalidFields: regulator.issues },
        { status: 422 },
      ),
    }
  }
  return {
    fields: {
      code: body.code as string,
      name: body.name as string,
      productType: body.productType as ProductFields["productType"],
      minAmount: Math.round((body.minAmount as number) * 100),
      maxAmount: Math.round((body.maxAmount as number) * 100),
      minTermDays: Number(body.minTermDays),
      maxTermDays: Number(body.maxTermDays),
      interestRatePm: Number(body.interestRatePm) / 100,
      interestModel: body.interestModel as ProductFields["interestModel"],
      initiationFeeModel: body.initiationFeeModel === "NCA_REG42" ? "NCA_REG42" : "FLAT_PCT",
      initiationFeePct: Number(body.initiationFeePct ?? 0) / 100,
      initiationFeeMax: Math.round(((body.initiationFeeMax as number | undefined) ?? 0) * 100),
      monthlyServiceFee: Math.round(((body.monthlyServiceFee as number | undefined) ?? 0) * 100),
      ...arrears.data,
      ...regulator.data,
    },
  }
}

/** What approves a change: every product change is a request, so a route answers 202 with the request, not the product. */
export const PENDING_APPROVAL = "PENDING_APPROVAL"
