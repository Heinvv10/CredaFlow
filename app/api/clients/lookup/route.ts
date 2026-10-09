import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { isValidSaIdNumber } from "@/lib/validation/client-wizard"
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

    // Refuse to probe on anything that is not a well-formed SA ID. This keeps
    // the endpoint from being walked with partial numbers to enumerate who is
    // on the book.
    if (!isValidSaIdNumber(idNumber)) {
      return NextResponse.json({ error: "A valid 13-digit SA ID number is required" }, { status: 422 })
    }

    const existing = await prisma.client.findFirst({
      where: { tenantId: tenant.id, idNumber },
      select: { id: true, reference: true, firstName: true, lastName: true },
    })

    if (existing) {
      return NextResponse.json({ exists: true, sameTenant: true, client: existing })
    }

    // idNumber is GLOBALLY unique, so absence from this tenant does not mean
    // the insert will succeed. Report the collision without identifying anyone:
    // the operator learns the ID is unusable here, and learns nothing about
    // another tenant's client. One tenant exists today, so this branch is
    // currently unreachable — it is written now so it cannot be got wrong later
    // under time pressure.
    //
    // withoutTenantScope is REQUIRED, not defensive. Client is a
    // tenant-scoped model and findUnique is one of the intercepted operations,
    // so this read would otherwise be rewritten to the caller's own tenant and
    // return null every time — a branch that looks like it checks for a
    // cross-tenant collision while being incapable of finding one. The bypass
    // selects nothing but existence, so widening the scope cannot widen what
    // the caller learns.
    const elsewhere = await withoutTenantScope(() =>
      prisma.client.findUnique({ where: { idNumber }, select: { id: true } })
    )

    if (elsewhere) {
      return NextResponse.json({ exists: true, sameTenant: false, client: null })
    }

    return NextResponse.json({ exists: false, sameTenant: false, client: null })
  })
}
