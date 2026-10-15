import { NextResponse } from "next/server"
import { requireApiRole, type StaffUser } from "@/lib/auth-guards"

/**
 * Who may create or revoke API keys and webhook endpoints: an ADMIN or above
 * of the tenant, in a session whose sign-in verified a TOTP code (a key is a
 * standing credential to the lender's book, so minting one is a staff write
 * that never skips 2FA, whatever the lender's staff-2FA policy).
 */
export async function requireApiSettingsAdmin(): Promise<{ error: NextResponse; user?: never } | { error?: never; user: StaffUser }> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return { error: guard.error }
  if (guard.user.totpVerified !== true) {
    return {
      error: NextResponse.json(
        { error: "Sign in with two-factor authentication to manage API keys and webhooks. Enable it under Settings → Security, then sign out and back in." },
        { status: 403 },
      ),
    }
  }
  return { user: guard.user }
}
