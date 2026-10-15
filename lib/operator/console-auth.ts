/**
 * Who may use the operator console (app/(operator), app/api/operator).
 *
 * An operator user (OPERATOR_ADMIN / OPERATOR_SUPPORT, bound to an operator,
 * no tenant) whose sign-in verified a TOTP code. The JWT callback re-reads the
 * user row on every request (lib/operator/sign-in.ts), so role and operator
 * here are the database's, not stale claims. OPERATOR_ADMIN alone creates and
 * suspends lenders, resets lender admins and manages operator users;
 * OPERATOR_SUPPORT views lenders and uses support grants.
 *
 * Every lender the console touches is looked up through the principal's own
 * operator (operatorTenant): another operator's lender is "not found".
 */
import { notFound, redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth-session"
import { prisma } from "@/lib/prisma"
import { isOperatorRole, type OperatorRole } from "./roles"
import { OPERATOR_ENROLMENT_PAGE } from "@/lib/proxy/operator-host"

export type OperatorPrincipal = {
  id: string
  email: string
  name: string | null
  role: OperatorRole
  operatorId: string
  totpVerified: true
}

type Refusal = "unauthenticated" | "not_operator" | "totp_required" | "admin_only"

async function resolvePrincipal(adminOnly: boolean): Promise<{ principal: OperatorPrincipal } | { refusal: Refusal }> {
  const session = await getSession()
  const user = session?.user
  if (!user) return { refusal: "unauthenticated" }
  if (!isOperatorRole(user.role) || typeof user.operatorId !== "string" || !user.operatorId || user.tenantId) {
    return { refusal: "not_operator" }
  }
  if (user.totpEnrolmentRequired !== false || user.totpVerified !== true) return { refusal: "totp_required" }
  if (adminOnly && user.role !== "OPERATOR_ADMIN") return { refusal: "admin_only" }
  return {
    principal: {
      id: user.id, email: user.email, name: user.name ?? null,
      role: user.role, operatorId: user.operatorId, totpVerified: true,
    },
  }
}

/** Console pages. Each page calls it itself: a page renders in parallel with its layout. */
export async function requireOperatorPage(opts: { admin?: boolean } = {}): Promise<OperatorPrincipal> {
  const result = await resolvePrincipal(opts.admin === true)
  if ("principal" in result) return result.principal
  if (result.refusal === "unauthenticated") redirect("/api/auth/expired?callbackUrl=%2Foperator")
  if (result.refusal === "totp_required") redirect(OPERATOR_ENROLMENT_PAGE)
  notFound()
}

/** Console APIs: 401/403 JSON instead of a redirect. */
export async function requireOperatorApi(
  opts: { admin?: boolean } = {},
): Promise<{ principal: OperatorPrincipal; error?: never } | { principal?: never; error: NextResponse }> {
  const result = await resolvePrincipal(opts.admin === true)
  if ("principal" in result) return result
  if (result.refusal === "unauthenticated") return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
}

/** The lender, if this operator runs it; otherwise null (render or answer 404). */
export function operatorTenant(principal: Pick<OperatorPrincipal, "operatorId">, tenantId: string) {
  return prisma.tenant.findFirst({
    where: { id: tenantId, operatorId: principal.operatorId },
    select: { id: true, slug: true, name: true, domain: true, status: true, createdAt: true },
  })
}
