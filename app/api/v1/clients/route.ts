import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withApiKey } from "@/lib/lender-api/handler"
import { hasScope } from "@/lib/lender-api/scopes"
import { pageOf, pageQuery, parsePageParams } from "@/lib/lender-api/pagination"
import { clientSelect, toApiClient } from "@/lib/lender-api/serializers"

export async function GET(req: Request) {
  return withApiKey(req, "clients:read", async (caller) => {
    const page = parsePageParams(new URL(req.url))
    if (page instanceof Response) return page
    const rows = await prisma.client.findMany({
      where: { tenantId: caller.tenantId },
      select: clientSelect,
      ...pageQuery(page),
    })
    const pii = hasScope(caller.scopes, "pii:read")
    return NextResponse.json(pageOf(rows, page, (c) => toApiClient(c, { pii })))
  })
}
