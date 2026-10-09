import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { ClientDecision } from "@prisma/client"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { recordAdvice, type RecordAdviceRefusal } from "@/lib/insurance/advice/record"
import { readJsonObject } from "../../../request-body"

const CLIENT_DECISIONS = Object.values(ClientDecision) as string[]

/**
 * A refusal reason and the status that represents it.
 *
 * ALREADY_RECORDED is a 409 rather than a 422: the request was well-formed and
 * the caller is not at fault, the record simply exists and is immutable.
 */
const REFUSAL_STATUS: Record<RecordAdviceRefusal, number> = {
  QUOTE_NOT_FOUND: 404,
  // Well-formed request, lost a race — the caller should re-read and retry.
  QUOTE_CHANGED: 409,
  ALREADY_RECORDED: 409,
  QUOTE_NOT_ADVISABLE: 409,
  REASON_REQUIRED: 422,
  MISSING_FIELD: 422,
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { id } = await params

      const record = await prisma.insuranceAdviceRecord.findFirst({
        where: { quoteId: id, tenantId: tenant.id },
        include: { recordedBy: { select: { id: true, name: true, email: true } } },
      })
      if (!record) {
        return NextResponse.json({ error: "No record of advice for this quote" }, { status: 404 })
      }

      return NextResponse.json(record)
    })
  } catch (error) {
    // Logged, matching the POST handler below. See the note in
    // app/api/insurance/quotes/route.ts — a silent 500 on a read
    // leaves no evidence to diagnose it with.
    console.error("Failed to fetch record of advice:", error)
    return NextResponse.json({ error: "Failed to fetch record of advice" }, { status: 500 })
  }
}

/**
 * Write the FAIS record of advice for a quote and advance it to
 * ADVICE_RECORDED.
 *
 * The route validates shape; `recordAdvice` owns the obligations — that a
 * departure from the recommendation carries its reason, that the quote is in a
 * state where advice means anything, and that an existing record is never
 * overwritten.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { id } = await params

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      const clientDecision = typeof body.clientDecision === "string" ? body.clientDecision : ""
      if (!CLIENT_DECISIONS.includes(clientDecision)) {
        return NextResponse.json(
          { error: `clientDecision must be one of ${CLIENT_DECISIONS.join(", ")}` },
          { status: 422 }
        )
      }

      if (body.productsConsidered === undefined || body.productsConsidered === null) {
        return NextResponse.json(
          { error: "productsConsidered is required — the record must show what was considered, not only what was recommended" },
          { status: 422 }
        )
      }

      // Variance cast for the $extends client, as in the quotes route and
      // app/(dashboard)/settings/insurance/page.tsx. Runtime shape is identical.
      const adviceStore = prisma as unknown as PrismaClient

      const result = await recordAdvice(adviceStore, {
        tenantId: tenant.id,
        quoteId: id,
        needsAnalysis: typeof body.needsAnalysis === "string" ? body.needsAnalysis : "",
        productsConsidered: body.productsConsidered,
        recommendation: typeof body.recommendation === "string" ? body.recommendation : "",
        clientDecision: clientDecision as ClientDecision,
        reasonIfDifferent: typeof body.reasonIfDifferent === "string" ? body.reasonIfDifferent : null,
        pdfUrl: typeof body.pdfUrl === "string" ? body.pdfUrl : null,
        recordedById: guard.user?.id ?? null,
      })

      if (!result.ok) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_ADVICE_REFUSED,
          entity: "InsuranceQuote",
          entityId: id,
          newValue: { reason: result.reason, detail: result.detail },
        })
        return NextResponse.json(
          { error: result.detail, reason: result.reason },
          { status: REFUSAL_STATUS[result.reason] }
        )
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_ADVICE_RECORDED,
        entity: "InsuranceAdviceRecord",
        entityId: result.adviceRecordId,
        newValue: {
          quoteId: id,
          clientDecision,
          // The hash, not the advice text: the audit row is the evidence that
          // THIS document was the one recorded, and the record itself holds
          // the content.
          contentHash: result.contentHash,
          quoteStatus: result.quoteStatus,
        },
      })

      return NextResponse.json(
        {
          id: result.adviceRecordId,
          quoteId: id,
          contentHash: result.contentHash,
          quoteStatus: result.quoteStatus,
        },
        { status: 201 }
      )
    })
  } catch (error) {
    console.error("Failed to record advice:", error)
    return NextResponse.json({ error: "Failed to record advice" }, { status: 500 })
  }
}
