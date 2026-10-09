import { NextResponse } from "next/server"
import { getLenderIdentity, LenderIdentityError, type LenderIdentity } from "./identity"

/**
 * For routes that render a statutory document: the tenant's identity, or a
 * 409 refusal naming what is missing. Any other error propagates.
 */
export async function lenderIdentityOrRefusal(
  tenantId: string,
): Promise<{ identity: LenderIdentity; refusal?: never } | { identity?: never; refusal: NextResponse }> {
  try {
    return { identity: await getLenderIdentity(tenantId) }
  } catch (e) {
    if (!(e instanceof LenderIdentityError)) throw e
    return {
      refusal: NextResponse.json(
        {
          error: "Lender identity is not configured. An administrator must complete Settings → Lender identity before this document can be issued.",
          code: "LENDER_IDENTITY_NOT_CONFIGURED",
          fields: e.fields,
        },
        { status: 409 },
      ),
    }
  }
}
