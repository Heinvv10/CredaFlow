import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const records = await prisma.complianceRecord.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          referenceId: true,
          dueDate: true,
          completedAt: true,
          createdAt: true,
          data: true,
        },
      })
      // ComplianceRecord.data may contain statutory snapshots with names, ID
      // numbers, addresses, recipient details, balances and private storage
      // paths. The generic READONLY listing needs only lifecycle state.
      return NextResponse.json(records.map((record) => {
        const lifecycle = record.data
          && typeof record.data === "object"
          && !Array.isArray(record.data)
          && typeof (record.data as { lifecycle?: unknown }).lifecycle === "string"
          ? (record.data as { lifecycle: string }).lifecycle
          : undefined
        return {
          id: record.id,
          type: record.type,
          status: record.status,
          referenceId: record.referenceId,
          dueDate: record.dueDate,
          completedAt: record.completedAt,
          createdAt: record.createdAt,
          data: lifecycle ? { lifecycle } : {},
        }
      }))
    } catch {
      return NextResponse.json({ error: "Failed to fetch compliance records" }, { status: 500 })
    }
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const body = await req.json()
      // These rows are authoritative legal/artifact registers, not generic
      // compliance notes. They may only be created by their guarded workflows,
      // which reserve the operation and write atomic evidence + audit trails.
      // KYC_EXCEPTION carries identity evidence that the composite KYC gate
      // reads. It is inert here today only because this route cannot set
      // completedAt — but a hand-crafted blob needs nothing a LOAN_ADMIN
      // cannot see on the client page, so do not leave that to one column.
      if (
        body.type === "SECTION_129_NOTICE" ||
        body.type === "AGREEMENT_ARTIFACT" ||
        body.type === "KYC_EXCEPTION" ||
        body.type === "DEBIT_MANDATE_ARTIFACT"
      ) {
        const dedicatedWorkflow = body.type === "SECTION_129_NOTICE"
          ? "loan collections"
          : body.type === "KYC_EXCEPTION"
            ? "KYC exception or in-person verification"
            : body.type === "AGREEMENT_ARTIFACT"
              ? "agreement generation"
              : "debit-mandate signing"
        return NextResponse.json(
          { error: `${body.type} records must be created through the dedicated ${dedicatedWorkflow} workflow.` },
          { status: 422 },
        )
      }
      const record = await prisma.complianceRecord.create({
        data: { tenantId: tenant.id, type: body.type, status: body.status || "PENDING", referenceId: body.referenceId, dueDate: body.dueDate ? new Date(body.dueDate) : null, data: body.data || {} },
      })
      return NextResponse.json(record)
    } catch {
      return NextResponse.json({ error: "Failed to create record" }, { status: 500 })
    }
  })
}
