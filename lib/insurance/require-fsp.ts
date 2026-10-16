/**
 * No insurance without an FSP number (Fair Score audit goal §2a.2). The lender
 * is a FAIS intermediary for every policy it sells; one that holds no FSP
 * licence number (TenantConfig.fscaNumber) may not disclose, quote or bind.
 */
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { LenderIdentityError, parseRequiredIdentityField, type LenderIdentity } from "@/lib/config/identity"

export const FSP_NOT_CONFIGURED = "LENDER_FSP_NOT_CONFIGURED"
export const FSP_REQUIRED_ERROR =
  "Insurance needs the lender's FSP licence number. An administrator must add it in Settings → Lender identity first."

/** The 409 an insurance write gets from a lender with no FSP number. */
export function fspRequiredResponse(): NextResponse {
  return NextResponse.json({ error: FSP_REQUIRED_ERROR, code: FSP_NOT_CONFIGURED }, { status: 409 })
}

/** A 409 when the identity already read holds no FSP number, else null. */
export function fspRefusal(identity: Pick<LenderIdentity, "fspNumber">): NextResponse | null {
  return identity.fspNumber ? null : fspRequiredResponse()
}

/** For a route that has not read the identity: the stored FSP number, validated as the identity is. */
export async function requireLenderFsp(tenantId: string): Promise<NextResponse | null> {
  return (await lenderHoldsFsp(prisma as unknown as FspReader, tenantId)) ? null : fspRequiredResponse()
}

type FspReader = { tenantConfig: { findUnique: (args: { where: { tenantId: string }; select: { fscaNumber: true } }) => Promise<{ fscaNumber: string | null } | null> } }

/**
 * Whether the lender holds a (valid) FSP number, read through the caller's
 * client or transaction. A lender without one issues no insurance: no
 * credit-life offer, no bundled policy.
 */
export async function lenderHoldsFsp(db: FspReader, tenantId: string): Promise<boolean> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { fscaNumber: true } })
  try {
    parseRequiredIdentityField("fscaNumber", config?.fscaNumber)
    return true
  } catch (e) {
    if (e instanceof LenderIdentityError) return false
    throw e
  }
}
