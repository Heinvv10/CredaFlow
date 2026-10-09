import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma, EligibilityLifeScope, EligibilityRuleType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { readJsonObject } from "../request-body"
import { parseDecimalAmount, DECIMAL_14_2_MAX_CENTS } from "../decimal-input"
import { parseTextValue } from "./rule-input"

const LIFE_SCOPES = Object.values(EligibilityLifeScope) as string[]
const RULE_TYPES = Object.values(EligibilityRuleType) as string[]

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const productId = req.nextUrl.searchParams.get("productId")

      const rules = await prisma.insuranceEligibilityRule.findMany({
        where: { tenantId: tenant.id, ...(productId ? { productId } : {}) },
        orderBy: [{ productId: "asc" }, { lifeScope: "asc" }, { ruleType: "asc" }],
      })

      return NextResponse.json(rules)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch eligibility rules" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      const productId = typeof body.productId === "string" ? body.productId : null
      if (!productId) {
        return NextResponse.json({ error: "productId is required" }, { status: 422 })
      }

      const ruleType = body.ruleType === undefined ? "" : String(body.ruleType)
      if (!RULE_TYPES.includes(ruleType)) {
        return NextResponse.json(
          { error: `ruleType must be one of ${RULE_TYPES.join(", ")}` },
          { status: 422 }
        )
      }

      const lifeScope =
        body.lifeScope === undefined ? EligibilityLifeScope.ALL_LIVES : String(body.lifeScope)
      if (!LIFE_SCOPES.includes(lifeScope)) {
        return NextResponse.json(
          { error: `lifeScope must be one of ${LIFE_SCOPES.join(", ")}` },
          { status: 422 }
        )
      }

      // Every rule type in EligibilityRuleType is numeric (ages, cover
      // amounts, day counts, life counts), so a rule without a number is not a
      // rule — it is a term nobody captured. The column is Decimal(14, 2):
      // Postgres would round a finer value and overflow a larger one, so both
      // ends are refused here.
      const numeric = parseDecimalAmount("numericValue", body.numericValue, {
        maxCents: DECIMAL_14_2_MAX_CENTS,
        allowZero: true,
      })
      if (!numeric.ok) return NextResponse.json({ error: numeric.error }, { status: 422 })
      const numericValue = numeric.value

      const text = parseTextValue(body.textValue)
      if (!text.ok) return NextResponse.json({ error: text.error }, { status: 422 })
      const textValue = text.value

      // `body.active === true` turned "true", 1 and null into an INACTIVE
      // rule: an insurer term captured, saved, and silently not in force. A
      // non-boolean is refused, which is what the PATCH path already did.
      if (body.active !== undefined && typeof body.active !== "boolean") {
        return NextResponse.json({ error: "active must be a boolean" }, { status: 422 })
      }
      const active = body.active === undefined ? true : body.active

      const product = await prisma.insuranceProduct.findFirst({
        where: { id: productId, tenantId: tenant.id },
        select: { id: true },
      })
      if (!product) {
        return NextResponse.json({ error: "Insurance product not found" }, { status: 404 })
      }

      let rule
      try {
        rule = await prisma.insuranceEligibilityRule.create({
          data: {
            tenantId: tenant.id,
            productId,
            lifeScope: lifeScope as EligibilityLifeScope,
            ruleType: ruleType as EligibilityRuleType,
            numericValue,
            textValue,
            active,
          },
        })
      } catch (err) {
        // @@unique([tenantId, productId, lifeScope, ruleType]) — the same term
        // configured twice would make screening depend on row order.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return NextResponse.json(
            { error: "That rule is already configured for this product and life scope" },
            { status: 409 }
          )
        }
        throw err
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_ELIGIBILITY_RULE_CREATED,
        entity: "InsuranceEligibilityRule",
        entityId: rule.id,
        // The PERSISTED row. It also carries `active`, whose absence from the
        // old hand-built payload left the log unable to explain why a captured
        // term was being ignored by screening.
        newValue: rule,
      })

      return NextResponse.json(rule)
    })
  } catch (error) {
    console.error("Failed to create eligibility rule:", error)
    return NextResponse.json({ error: "Failed to create eligibility rule" }, { status: 500 })
  }
}
