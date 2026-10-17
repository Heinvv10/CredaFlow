import { NextResponse } from "next/server"
import type { ReferenceRateBasis } from "@prisma/client"
import { canDo, type AppRole } from "@/lib/auth-guards"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"

// Who may record or decide a reference rate. The repo rate sets the NCA
// interest-rate cap on unsecured consumer credit (lib/loan/nca-interest-cap.ts),
// so every lender needs it whether or not it has asset finance: REPO is gated
// by the manage_repo_rate permission alone. Every other basis is an
// asset-finance rate behind the module's feature flag and decide_asset_finance.

export type RateAccess =
  | { ok: true }
  | { ok: false; response: NextResponse; reason: string | null; permission: string }

export async function referenceRateAccess(tenantId: string, basis: ReferenceRateBasis, role: AppRole): Promise<RateAccess> {
  if (basis === "REPO") {
    return canDo(role, "manage_repo_rate")
      ? { ok: true }
      : {
          ok: false, reason: "insufficient_role", permission: "manage_repo_rate",
          response: NextResponse.json({ error: "The repo rate needs the manage_repo_rate permission" }, { status: 403 }),
        }
  }
  const disabled = await requireAssetFinanceEnabled(tenantId)
  if (disabled) return { ok: false, response: disabled, reason: null, permission: "decide_asset_finance" }
  return canDo(role, "decide_asset_finance")
    ? { ok: true }
    : {
        ok: false, reason: "insufficient_role", permission: "decide_asset_finance",
        response: NextResponse.json({ error: "A reference rate needs the decide_asset_finance permission" }, { status: 403 }),
      }
}

/** Without asset finance a tenant has only its repo rate. */
export async function visibleReferenceBases(tenantId: string): Promise<ReferenceRateBasis[] | null> {
  return (await requireAssetFinanceEnabled(tenantId)) ? ["REPO"] : null
}
