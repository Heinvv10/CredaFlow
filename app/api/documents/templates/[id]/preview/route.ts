import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { extractTokens, renderTokens, type TokenContext } from "@/lib/documents/tokens"
import { findLenderIdentity } from "@/lib/config/identity"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Preview-only: renders `bodyHtml` against a sample client's TokenContext.
 * No persistence — no version write, no ClientDocument, no audit log. Used
 * by the CUSTOM template editor's Preview button before Save/Publish.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const template = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: tenant.id, deletedAt: null },
    })
    if (!template) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    // SYSTEM templates never reach the editor (Task 10's page.tsx redirects
    // away from them), but guard defensively the same as the sibling routes.
    if (template.kind === "SYSTEM") {
      return NextResponse.json({ error: "System templates are read-only" }, { status: 403 })
    }

    const body = (await req.json()) as { bodyHtml?: string; clientId?: string }
    if (!body.bodyHtml?.trim()) {
      return NextResponse.json({ error: "bodyHtml is required" }, { status: 422 })
    }

    const client = body.clientId
      ? await prisma.client.findFirst({ where: { id: body.clientId, tenantId: tenant.id } })
      : await prisma.client.findFirst({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: "asc" },
        })

    // No sample client available (none given/found, or the tenant has no
    // clients yet). Every TOKEN_REGISTRY resolver that reads ctx.client
    // assumes it's present — TokenContext.client is non-optional — so we
    // can't safely build a context at all. Report every token found in the
    // body as unresolved rather than crashing or rendering "undefined".
    if (!client) {
      return NextResponse.json({ html: body.bodyHtml, missing: extractTokens(body.bodyHtml) })
    }

    const tenantRow = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })

    const [loan, application] = await Promise.all([
      prisma.loan.findFirst({
        where: { clientId: client.id, tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
      }),
      prisma.loanApplication.findFirst({
        where: { clientId: client.id, tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
        include: { product: true },
      }),
    ])

    const lender = await findLenderIdentity(tenant.id)
    const ctx: TokenContext = { tenant: tenantRow, lender, client, application, loan }

    return NextResponse.json(renderTokens(body.bodyHtml, ctx))
  })
}
