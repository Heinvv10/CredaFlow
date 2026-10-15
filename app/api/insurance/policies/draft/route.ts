// app/api/insurance/policies/draft/route.ts
import { NextResponse, type NextRequest } from "next/server"
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { lenderIdentityOrRefusal } from "@/lib/config/identity-response"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { generateFaisDisclosurePdf } from "@/lib/pdf/faisDisclosure"
import { signDraftToken } from "@/lib/insurance/disclosure-token"
import { requiresRating, screenDraftRating } from "@/lib/insurance/policy/draft-rating-gate"
import type { PrismaClient } from "@prisma/client"
import { InsurancePolicyType } from "@prisma/client"
import { parseDecimalAmount, DECIMAL_12_2_MAX_CENTS } from "../../decimal-input"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { saveFileAt } from "@/lib/storage"
const POLICY_TYPES = Object.values(InsurancePolicyType) as string[]

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("INSURANCE_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const blocked = await requireImsEnabled(tenant.id)
    if (blocked) return blocked

    let body: {
      clientId?: string
      advisorId?: string
      productId?: string
      type?: string
      sumAssured?: unknown
      premiumAmount?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 })
    }
    const { clientId, advisorId, productId, type, sumAssured, premiumAmount } = body

    if (!clientId || !advisorId || !type || typeof sumAssured !== "number" || typeof premiumAmount !== "number") {
      return NextResponse.json({ error: "Missing or invalid fields" }, { status: 422 })
    }

    // `type` was previously any truthy string. It selects the rating branch, so
    // an unrecognised value was a way past the branch rather than a bad request.
    if (!POLICY_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `type must be one of ${POLICY_TYPES.join(", ")}` },
        { status: 422 }
      )
    }

    // Money is validated for EVERY type, not only the rated ones. The rated
    // branch compares in exact cents, but the non-rated branch did no numeric
    // validation at all — so a negative premium, or one with sub-cent decimals
    // that Postgres would round away, reached the disclosure PDF and the token.
    const parsedSum = parseDecimalAmount("sumAssured", sumAssured, { maxCents: DECIMAL_12_2_MAX_CENTS })
    if (!parsedSum.ok) return NextResponse.json({ error: parsedSum.error }, { status: 422 })
    const parsedPremium = parseDecimalAmount("premiumAmount", premiumAmount, { maxCents: DECIMAL_12_2_MAX_CENTS })
    if (!parsedPremium.ok) return NextResponse.json({ error: parsedPremium.error }, { status: 422 })

    const [client, advisor, product] = await Promise.all([
      prisma.client.findUnique({ where: { id: clientId, tenantId: tenant.id } }),
      prisma.user.findUnique({ where: { id: advisorId, tenantId: tenant.id } }),
      productId
        ? prisma.insuranceProduct.findUnique({ where: { id: productId, tenantId: tenant.id } })
        : Promise.resolve(null),
    ])

    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })
    if (!advisor) return NextResponse.json({ error: "Advisor not found" }, { status: 404 })
    if (productId && !product) return NextResponse.json({ error: "Product not found" }, { status: 404 })

    // THE BYPASS THIS CLOSES. `type` arrives in the request body and used to
    // select the rating branch on its own, while `product` was fetched and its
    // own type never consulted. So:
    //
    //   { productId: <a FUNERAL_COVER product>, type: "CREDIT_LIFE",
    //     sumAssured: 50000, premiumAmount: 0 }
    //
    // made `requiresRating("CREDIT_LIFE")` false, skipped the gate entirely,
    // and issued a client-facing FAIS disclosure at a premium no rate card
    // produced. A type that disagrees with its own product is not a valid
    // request under any reading.
    if (product && product.type !== type) {
      return NextResponse.json(
        { error: `type ${type} does not match the product's type ${product.type}` },
        { status: 422 }
      )
    }

    // The rating decision is derived from the PRODUCT, not from the body.
    // Where no product is named there is nothing to derive from, so the body's
    // type stands — and a rated type with no product then reaches the gate's
    // own PRODUCT_REQUIRED refusal, which was previously unreachable because
    // the gate was skipped before it could be consulted.
    const ratingType = product?.type ?? type

    // ── Rating gate ────────────────────────────────────────────────────────
    //
    // Ahead of the PDF, deliberately. This route ISSUES a client-facing FAIS
    // disclosure; a premium the insurer's rate card does not produce must never
    // reach that document, so the check happens before a byte is rendered or
    // written. FUNERAL_COVER and LIFE_INSURANCE only — credit life and the
    // short-term types have no rate cards and are priced elsewhere.
    if (requiresRating(ratingType)) {
      // Variance cast for the $extends client, as in the quotes routes.
      const ratingReader = prisma as unknown as PrismaClient
      const screened = await screenDraftRating(ratingReader, {
        tenantId: tenant.id,
        productId: productId ?? null,
        type: ratingType,
        sumAssured,
        premiumAmount,
        clientDateOfBirth: client.dateOfBirth,
        at: new Date(),
      })

      if (!screened.ok) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_DRAFT_RATING_REJECTED,
          entity: "InsurancePolicy",
          newValue: {
            reason: screened.reason,
            detail: screened.detail,
            clientId,
            productId: productId ?? null,
            type: ratingType,
            requestedPremium: premiumAmount,
            derivedPremium: screened.derivedPremium,
          },
        })
        return NextResponse.json(
          {
            error: screened.detail,
            reason: screened.reason,
            derivedPremium: screened.derivedPremium,
          },
          { status: 409 },
        )
      }
    }

    // The disclosure names the FSP and its licence number: refuse when the
    // lender identity is not configured.
    const lender = await lenderIdentityOrRefusal(tenant.id)
    if (lender.refusal) return lender.refusal

    const draftToken = signDraftToken({
      tenantId: tenant.id,
      clientId,
      advisorId,
      type,
      sumAssured,
      premiumAmount,
      productId: productId ?? null,
    })

    // draftToken format is "<payload>.<sig>", so the on-disk filename contains
    // two dots, e.g. "abc123.xyz789.pdf". Task 7 reads by reconstructing this
    // exact path — do not split on "." to derive a base name. Written through
    // lib/storage, so encrypted at rest like every upload.
    const storageRelativePath = `disclosures/${tenant.id}/${draftToken}.pdf`

    const pdfBuffer = await generateFaisDisclosurePdf({
      lender: lender.identity,
      logo: await getLenderLogo(tenant.id),
      client: {
        firstName: client.firstName,
        lastName: client.lastName,
        idNumber: client.idNumber,
      },
      advisor: {
        name: advisor.name ?? advisor.email,
        designation: "Insurance Officer",
      },
      product: {
        type,
        name: product?.name ?? type,
      },
      policyDraft: { sumAssured, premiumAmount },
    })

    await saveFileAt(storageRelativePath, pdfBuffer)
    const pdfSha256 = createHash("sha256").update(pdfBuffer).digest("hex")

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.INSURANCE_FAIS_DISCLOSURE_RENDERED,
      entity: "InsurancePolicy",
      newValue: { advisorId, clientId, draftToken, pdfSha256, type, sumAssured, premiumAmount },
    })

    return NextResponse.json(
      { pdfUrl: `/api/insurance/disclosures/${draftToken}`, draftToken },
      { status: 201 },
    )
  })
}
