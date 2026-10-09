import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"

// Fields whose values appear on the FAIS disclosure PDF that the client
// acknowledged at bind. Mutating any of them on a STANDALONE policy would
// leave the persisted policy out of sync with the signed disclosure —
// re-disclosure is required, which means cancel + rebind.
//
// **Contract:** this list must be a superset of every priced/disclosed
// field that the PATCH handler below actually writes to. The disclosure
// PDF (lib/pdf/faisDisclosure.ts) also reproduces `type`, `productId`,
// `sumAssured`, and `advisorId`; if those ever become PATCH-writable,
// they MUST be added here in the same change.
const FAIS_LOCKED_FIELDS = ["premiumAmount", "insurer", "insurerId"] as const

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const policy = await prisma.insurancePolicy.findFirst({
        where: { id, tenantId: tenant.id },
        include: {
          claims: { orderBy: { submittedAt: "desc" } },
          premiumPayments: { orderBy: { dueDate: "asc" } },
        },
      })

      if (!policy) return NextResponse.json({ error: "Not found" }, { status: 404 })
      return NextResponse.json(policy)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch policy" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const data = await req.json()

      const existing = await prisma.insurancePolicy.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, pprIssuedAt: true, policySource: true },
      })
      if (!existing) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      }

      if (data.status === "ACTIVE" && !existing.pprIssuedAt) {
        return NextResponse.json(
          { error: "Product disclosure must be issued before activating policy" },
          { status: 400 }
        )
      }

      // FAIS lockdown — see FAIS_LOCKED_FIELDS comment above. Changes to these
      // fields on a STANDALONE policy invalidate the disclosure the client
      // acknowledged at bind; rebind via cancel + new policy is the supported
      // path (audited via AuditAction.INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED
      // on the new policy).
      if (existing.policySource === "STANDALONE") {
        const attempted = FAIS_LOCKED_FIELDS.filter((f) => data[f] !== undefined)
        if (attempted.length > 0) {
          await logAudit({
            tenantId: tenant.id,
            userId: guard.user?.id,
            userEmail: guard.user?.email,
            action: AuditAction.INSURANCE_PATCH_FAIS_LOCKED,
            entity: "InsurancePolicy",
            entityId: id,
            newValue: { attemptedFields: attempted },
          })
          return NextResponse.json(
            {
              error: `Cannot change FAIS-disclosed fields on a STANDALONE policy. Cancel this policy and rebind to issue a fresh disclosure. Locked: ${attempted.join(", ")}`,
            },
            { status: 422 }
          )
        }
      }

      const policy = await prisma.insurancePolicy.update({
        where: { id, tenantId: tenant.id },
        data: {
          ...(data.status ? { status: data.status } : {}),
          ...(data.renewalDate ? { renewalDate: new Date(data.renewalDate) } : {}),
          ...(data.premiumAmount !== undefined ? { premiumAmount: parseFloat(data.premiumAmount) } : {}),
          ...(data.insurer ? { insurer: data.insurer } : {}),
          ...(data.insurerId !== undefined ? { insurerId: data.insurerId } : {}),
          // Risk info fields
          ...(data.vehicleRegNumber !== undefined ? { vehicleRegNumber: data.vehicleRegNumber } : {}),
          ...(data.vehicleValue !== undefined ? { vehicleValue: data.vehicleValue ? parseFloat(data.vehicleValue) : null } : {}),
          ...(data.vehicleUse !== undefined ? { vehicleUse: data.vehicleUse } : {}),
          ...(data.propertyAddress !== undefined ? { propertyAddress: data.propertyAddress } : {}),
          ...(data.constructionType !== undefined ? { constructionType: data.constructionType } : {}),
          ...(data.propertyValue !== undefined ? { propertyValue: data.propertyValue ? parseFloat(data.propertyValue) : null } : {}),
        },
      })

      return NextResponse.json(policy)
    })
  } catch {
    return NextResponse.json({ error: "Failed to update policy" }, { status: 500 })
  }
}
