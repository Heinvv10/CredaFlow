import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { readJsonObject } from "../../request-body"
import { parseDecimalAmount, DECIMAL_14_2_MAX_CENTS } from "../../decimal-input"
import { parseTextValue } from "../rule-input"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const rule = await prisma.insuranceEligibilityRule.findFirst({
        where: { id, tenantId: tenant.id },
      })
      if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 })

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      // productId, lifeScope and ruleType are the rule's IDENTITY — they form
      // the unique key. Moving a rule across any of them is a delete plus a
      // create, not an edit, so a PATCH may only change the rule's value and
      // whether it is in force.
      const data: { numericValue?: number; textValue?: string | null; active?: boolean } = {}

      if (body.numericValue !== undefined) {
        // Decimal(14, 2) — see the POST route for why both ends are bounded
        // here rather than left to Postgres to round or overflow.
        const numeric = parseDecimalAmount("numericValue", body.numericValue, {
          maxCents: DECIMAL_14_2_MAX_CENTS,
          allowZero: true,
        })
        if (!numeric.ok) return NextResponse.json({ error: numeric.error }, { status: 422 })
        data.numericValue = numeric.value
      }

      if (body.textValue !== undefined) {
        const text = parseTextValue(body.textValue)
        if (!text.ok) return NextResponse.json({ error: text.error }, { status: 422 })
        data.textValue = text.value
      }

      if (body.active !== undefined) {
        if (typeof body.active !== "boolean") {
          return NextResponse.json({ error: "active must be a boolean" }, { status: 422 })
        }
        data.active = body.active
      }

      // A body with no writable key is not an edit. Prisma would still issue
      // the UPDATE — bumping @updatedAt — and the audit row below would read
      // `newValue: {}`: evidence of a change to an insurer acceptance term
      // that did not occur. The sibling rate-table PATCH refuses the same
      // case; the two must agree.
      if (Object.keys(data).length === 0) {
        return NextResponse.json(
          { error: "No writable fields supplied. Send numericValue, textValue or active." },
          { status: 422 }
        )
      }

      const updated = await prisma.insuranceEligibilityRule.update({ where: { id }, data })

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_ELIGIBILITY_RULE_UPDATED,
        entity: "InsuranceEligibilityRule",
        entityId: id,
        oldValue: {
          numericValue: rule.numericValue === null ? null : Number(rule.numericValue),
          textValue: rule.textValue,
          active: rule.active,
        },
        // The persisted row, not the parsed input — the audit trail is
        // evidence of what the database holds.
        newValue: updated,
      })

      return NextResponse.json(updated)
    })
  } catch (error) {
    console.error("Failed to update eligibility rule:", error)
    return NextResponse.json({ error: "Failed to update eligibility rule" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const rule = await prisma.insuranceEligibilityRule.findFirst({
        where: { id, tenantId: tenant.id },
      })
      if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 })

      await prisma.insuranceEligibilityRule.delete({ where: { id } })

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_ELIGIBILITY_RULE_DELETED,
        entity: "InsuranceEligibilityRule",
        entityId: id,
        oldValue: {
          productId: rule.productId,
          lifeScope: rule.lifeScope,
          ruleType: rule.ruleType,
          numericValue: rule.numericValue === null ? null : Number(rule.numericValue),
          textValue: rule.textValue,
          active: rule.active,
        },
      })

      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    console.error("Failed to delete eligibility rule:", error)
    return NextResponse.json({ error: "Failed to delete eligibility rule" }, { status: 500 })
  }
}
