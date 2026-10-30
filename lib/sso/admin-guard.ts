import { NextResponse } from "next/server"
import { requireApiRole, type StaffUser } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"

/**
 * Who may change how staff sign in or what can call the API: the permission's
 * role (a SUPER_ADMIN), in a session whose sign-in verified a CredaFlow TOTP
 * code. Provider MFA does not count: the same rule as the other identity and
 * credential writes (PUT /api/settings/identity, API keys).
 */
export async function requireSsoAdmin(
  permission: "manage_sso" | "manage_oauth_clients",
): Promise<{ error: NextResponse; user?: never } | { error?: never; user: StaffUser }> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return { error: guard.error }
  if (!canDo(guard.user.role, permission)) {
    return { error: NextResponse.json({ error: "Only a Super Admin can do this." }, { status: 403 }) }
  }
  if (guard.user.totpVerified !== true) {
    return {
      error: NextResponse.json(
        { error: "Sign in with a two-factor authentication code to change this. Enable it under Settings → Security, then sign out and back in." },
        { status: 403 },
      ),
    }
  }
  return { user: guard.user }
}
