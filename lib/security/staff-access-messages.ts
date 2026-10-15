/**
 * Client-safe half of the staff access policy: the refusal reasons and what
 * the sign-in form says for each. Kept apart from staff-access-policy.ts,
 * which imports node:net and cannot reach a browser bundle.
 */
export type StaffAccessRefusal = "outside_hours" | "ip_not_allowed" | "policy_invalid"

/** The CredentialsSignin code lib/auth.ts throws for a refusal. */
export const staffAccessSignInCode = (reason: StaffAccessRefusal) => `access_${reason}`

const MESSAGES: Record<string, string> = {
  access_outside_hours: "Sign-in is closed outside your lender's staff working hours.",
  access_ip_not_allowed: "Sign-in is not allowed from this network.",
  access_policy_invalid:
    "Sign-in is blocked by your lender's access policy. Ask a Super Admin to check Settings → Security & KYC policy.",
  portal_disabled: "The client portal is not available. Please contact your lender.",
}

/** The message for a sign-in error code, or null when the code is not one of these refusals. */
export function accessRefusalMessage(code: string | undefined): string | null {
  return code ? MESSAGES[code] ?? null : null
}
