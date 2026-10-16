/**
 * Support access is read-only (lib/operator/). proxy.ts refuses every
 * operator request that could write — API routes, pages and server actions
 * (a POST carrying Next-Action) alike — and stamps each request it lets
 * through with its method and an id, so the Node-side guards
 * (lib/operator/tenant-access.ts) can refuse writes with an audit row and
 * record one use per request.
 */
import { NextResponse } from "next/server"
import { isOperatorRole } from "@/lib/operator/roles"

export const REQUEST_METHOD_HEADER = "x-cf-request-method"
export const REQUEST_ID_HEADER = "x-cf-request-id"
/** The request's path as the edge saw it, for the guards' loan-book check (lib/auth-guards.ts). */
export const REQUEST_PATH_HEADER = "x-cf-request-path"

const READ_METHODS = new Set(["GET", "HEAD"])

/** True for the methods support access may use. */
export function isReadMethod(method: string | null | undefined): boolean {
  return !!method && READ_METHODS.has(method.toUpperCase())
}

/** Replaces any caller-supplied stamp with the edge's own. */
export function stampRequest(headers: Headers, method: string, path: string): Headers {
  for (const header of [REQUEST_METHOD_HEADER, REQUEST_ID_HEADER, REQUEST_PATH_HEADER]) headers.delete(header)
  headers.set(REQUEST_METHOD_HEADER, method.toUpperCase())
  headers.set(REQUEST_ID_HEADER, crypto.randomUUID())
  headers.set(REQUEST_PATH_HEADER, path)
  return headers
}

/**
 * The refusal for an operator session's write, or null. Sign-in and sign-out
 * (/api/auth/*) stay open: an operator must be able to end the session.
 */
export function operatorWriteRefusal(role: unknown, method: string, path: string): Response | null {
  if (!isOperatorRole(role) || isReadMethod(method) || path.startsWith("/api/auth/")) return null
  return NextResponse.json({ error: "Support access is read-only" }, { status: 403 })
}
