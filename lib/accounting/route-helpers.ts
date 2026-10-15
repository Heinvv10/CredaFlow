/**
 * Shared by the accounting, Xero and payout routes: the TOTP gate on writes
 * (the same rule as app/api/settings/bureau) and a safe JSON body read.
 */
import { NextResponse } from "next/server"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"

/** 403 when this lender requires staff 2FA and this session did not verify a code. */
export async function totpWriteRefusal(tenantId: string, user: { totpVerified?: boolean }, what: string): Promise<NextResponse | null> {
  if ((await isStaffTotpRequired(tenantId)) && user.totpVerified !== true) {
    return NextResponse.json(
      { error: `Sign in with two-factor authentication to ${what}. Enable it under Settings → Security, then sign out and back in.` },
      { status: 403 },
    )
  }
  return null
}

export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }) }
  }
}
