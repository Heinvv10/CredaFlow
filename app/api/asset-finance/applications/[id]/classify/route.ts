import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { classifyApplication } from "@/lib/asset-finance/classification"

const MAX_EVIDENCE_IDS = 50

function parseTrusteeEvidenceIds(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const value = (body as { trusteeEvidenceIds?: unknown }).trusteeEvidenceIds
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return null
    ids.push(item.trim())
  }
  return [...new Set(ids)]
}

/**
 * Classify an entity application as NCA or NON_NCA (DESIGN D5) and snapshot
 * the result on it. Body: `{ trusteeEvidenceIds?: string[] }`.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled

    const { id } = await params
    const body: unknown = await req.json().catch(() => ({}))
    const trusteeEvidenceIds = parseTrusteeEvidenceIds(body)
    if (!trusteeEvidenceIds) {
      return NextResponse.json(
        { error: `trusteeEvidenceIds must be an array of at most ${MAX_EVIDENCE_IDS} non-empty strings` },
        { status: 400 },
      )
    }

    const result = await prisma.$transaction((tx) =>
      classifyApplication(tx, {
        tenantId: tenant.id,
        applicationId: id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        trusteeEvidenceIds,
        mayClassifyNonNca: canDo(guard.user.role, "decide_asset_finance"),
      }),
    )

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      case "not_entity_borrower":
        return NextResponse.json(
          { error: "Only a business-entity application is classified; a natural person is always NCA" },
          { status: 422 },
        )
      case "regime_frozen":
        return NextResponse.json(
          { error: `The NCA regime is frozen once an application is ${result.status}` },
          { status: 409 },
        )
      case "needs_override":
        return NextResponse.json(
          {
            error: "The application is NCA; moving it to NON_NCA needs an approved override",
            needsOverride: true,
            classification: result.classification,
          },
          { status: 409 },
        )
      case "needs_credit_authority":
        return NextResponse.json(
          {
            error: "A NON_NCA classification switches off consumer protections and needs a user with credit authority",
            classification: result.classification,
          },
          { status: 403 },
        )
      case "classified":
        return NextResponse.json({
          classification: result.classification,
          previousRegime: result.previousRegime,
        })
    }
  })
}
