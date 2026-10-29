import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { idNumberCopy, isValidIdNumber } from "@/lib/validation/client-wizard"
import { checkRateLimit } from "@/lib/rate-limit"

/**
 * Enough for an operator correcting a typo through a shift; nowhere near enough
 * to script existence probes across a meaningful share of the ID space.
 */
const LOOKUP_RATE_LIMIT = { limit: 40, windowMs: 60_000 }

/**
 * Does a client with this ID number already exist?
 *
 * Exists so the wizard can say so while the operator is still on step 1,
 * rather than after they have filled in four steps. It does NOT replace the
 * conflict handling on POST /api/clients: two operators can pass this check
 * at the same moment and only the unique index settles that race, so the
 * write path stays authoritative and this is purely an early warning.
 *
 * Same role as creating a client (CREDIT_OFFICER). A lower bar would turn this
 * into an ID-number oracle for anyone who can sign in.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  // Keyed by USER, deliberately not by IP.
  //
  // Every other rate limit in this codebase keys on the caller's address, which
  // is right for anonymous public forms. It would be wrong here: branch staff
  // share one office egress address, so an IP key would put every credit
  // officer in a single bucket and let ordinary use lock the whole branch out —
  // the same shape as the login bucket that self-DoSes when TRUSTED_PROXY is
  // unset. The user id is already authenticated at this point, cannot be
  // spoofed, and attributes a scripted probe to the account running it.
  const gate = checkRateLimit(`clients:lookup:${guard.user.id}`, LOOKUP_RATE_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many lookups. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    )
  }

  return await withTenantContext(req, async (tenant) => {
    const idNumber = req.nextUrl.searchParams.get("idNumber")?.trim() ?? ""

    // Refuse to probe on anything that is not a well-formed national ID. This keeps
    // the endpoint from being walked with partial numbers to enumerate who is
    // on the book.
    if (!isValidIdNumber(idNumber)) {
      return NextResponse.json({ error: idNumberCopy().refusal }, { status: 422 })
    }

    const existing = await prisma.client.findFirst({
      where: { tenantId: tenant.id, idNumber },
      select: { id: true, reference: true, firstName: true, lastName: true },
    })

    if (existing) {
      return NextResponse.json({ exists: true, sameTenant: true, client: existing })
    }

    // Client.idNumber is unique per tenant (borrowers are per lender), so
    // absence from this tenant means the insert can succeed. Another lender's
    // clients are deliberately not consulted: whether a person borrows
    // elsewhere is that lender's data.
    return NextResponse.json({ exists: false, sameTenant: false, client: null })
  })
}
