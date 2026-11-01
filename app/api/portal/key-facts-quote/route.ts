import { NextResponse, type NextRequest } from "next/server"
import { auth } from "@/lib/auth"
import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"
import { issueIndicativeKeyFacts } from "@/lib/non-nca-documents/pre-submission"
import { newApplicationRegime } from "@/lib/non-nca-documents/regime-evidence"
import { checkRateLimit, recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"

/** Each statement is a real render: a borrower trying amounts is fine, a loop is not. */
const RATE_LIMIT = { limit: 15, windowMs: 60 * 60 * 1000 } as const

/** The borrower's key facts statement for the amount and term on their screen, before they apply (tender 2.2.4). */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "CLIENT") return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const clientId = session.user.id
  const gate = await checkRateLimit(`portal:key-facts:${clientId}`, RATE_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } })
  }
  const body = await req.json().catch(() => null) as { productCode?: unknown; amount?: unknown; termDays?: unknown } | null
  const amountCents = Math.round(Number(body?.amount) * 100)
  if (typeof body?.productCode !== "string" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "productCode and a positive amount are required." }, { status: 400 })
  }
  const productCode = body.productCode
  const termDays = body.termDays === undefined ? undefined : Number(body.termDays)
  return withTenantContext(req, async (tenant) => {
    if (newApplicationRegime() !== "KEY_FACTS") return NextResponse.json({ error: "This lender's applications are governed by the PASQ." }, { status: 409 })
    try {
      const result = await issueIndicativeKeyFacts({ tenantId: tenant.id, clientId, clientEmail: session.user.email ?? null, productCode, amountCents, termDays, ipAddress: recordedCallerIp(req) ?? undefined })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      if (error instanceof TemplateUnavailableError || error instanceof MissingTokenError) {
        return NextResponse.json({ error: "The key facts statement is not available at the moment. Please contact us." }, { status: 409 })
      }
      throw error
    }
  })
}
