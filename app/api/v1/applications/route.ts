import { NextResponse } from "next/server"
import type { AppStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withApiKey } from "@/lib/lender-api/handler"
import { hasScope } from "@/lib/lender-api/scopes"
import { readJsonBody } from "@/lib/lender-api/body"
import { optionalEnumParam, optionalIdParam, pageOf, pageQuery, pageWhere, parsePageParams } from "@/lib/lender-api/pagination"
import { applicationSelect, toApiApplication } from "@/lib/lender-api/serializers"
import { createDraftApplication, parseCreateApplication } from "@/lib/lender-api/create-application"

const MAX_BODY_BYTES = 16 * 1024

const APPLICATION_STATUSES: readonly AppStatus[] = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED", "CANCELLED",
]

export async function GET(req: Request) {
  return withApiKey(req, "applications:read", async (caller) => {
    const url = new URL(req.url)
    const page = parsePageParams(url)
    if (page instanceof Response) return page
    const status = optionalEnumParam(url, "status", APPLICATION_STATUSES)
    if (status instanceof Response) return status
    const clientId = optionalIdParam(url, "clientId")
    if (clientId instanceof Response) return clientId
    const rows = await prisma.loanApplication.findMany({
      where: { tenantId: caller.tenantId, ...(status ? { status } : {}), ...(clientId ? { clientId } : {}), ...pageWhere(page) },
      select: applicationSelect,
      ...pageQuery(page),
    })
    const pii = hasScope(caller.scopes, "pii:read")
    return NextResponse.json(pageOf(rows, page, (a) => toApiApplication(a, { pii })))
  })
}

export async function POST(req: Request) {
  return withApiKey(req, "applications:write", async (caller) => {
    // The create body is a handful of fields: stop reading at the cap.
    const body = await readJsonBody(req, MAX_BODY_BYTES)
    if (body instanceof Response) return body
    const input = parseCreateApplication(body.value)
    if ("status" in input) return NextResponse.json(input.body, { status: input.status })
    const outcome = await createDraftApplication(caller, input)
    return NextResponse.json(outcome.body, { status: outcome.status })
  })
}
