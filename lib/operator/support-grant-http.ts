import { NextResponse } from "next/server"
import { SupportGrantRefusal, type SupportGrantRefusalReason } from "./support-grants"

const STATUS: Record<SupportGrantRefusalReason, { status: number; error: string }> = {
  not_lender_admin: { status: 403, error: "Only this lender's ADMIN or SUPER_ADMIN can manage support access" },
  totp_required: {
    status: 403,
    error: "Sign in with two-factor authentication to manage support access. Enable it under Settings → Security, then sign out and back in.",
  },
  bad_window: { status: 400, error: "Support access lasts from 1 hour to 7 days" },
  reason_required: { status: 400, error: "A reason (up to 500 characters) is required" },
  operator_user_invalid: { status: 400, error: "That person is not an active member of your platform operator's staff" },
  grant_not_found: { status: 404, error: "No active grant with that id" },
}

/** A support-grant refusal as a route response (already audited by support-grants.ts); null for any other error. */
export function supportGrantRefusalResponse(err: unknown): NextResponse | null {
  if (!(err instanceof SupportGrantRefusal)) return null
  const { status, error } = STATUS[err.reason]
  return NextResponse.json({ error, reason: err.reason }, { status })
}
