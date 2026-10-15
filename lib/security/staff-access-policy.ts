/**
 * Staff access restrictions per lender: working hours and an IP allowlist
 * (TenantConfig.staffAccessHours / staffIpAllowlist). Pure decision logic;
 * enforcement is in lib/security/staff-access-enforcement.ts, called at
 * sign-in (lib/auth.ts authorize) and on every node-side session read
 * (lib/auth.ts jwt callback, where tokenVersion revocation already runs).
 *
 * A SUPER_ADMIN is never refused, so a lender cannot lock itself out, but
 * every time the policy would have refused one the bypass is audited.
 */
import { parseStaffAccessHours, isWithinAccessHours, type StaffAccessHours } from "./staff-access-hours"
import { ipInAllowlist, parseIpAllowlist } from "./ip-allowlist"
import type { StaffAccessRefusal } from "./staff-access-messages"

export type { StaffAccessRefusal }

export type StaffAccessPolicy = {
  hours: StaffAccessHours | null
  ipAllowlist: string[]
  /** The stored policy could not be read: fail closed. */
  invalid: boolean
}

export type StaffAccessPolicyColumns = {
  staffAccessHours: unknown
  staffIpAllowlist: string[] | null
}

export type StaffAccessDecision =
  | { allowed: true; bypassed?: StaffAccessRefusal }
  | { allowed: false; reason: StaffAccessRefusal }

export const UNRESTRICTED_POLICY: StaffAccessPolicy = { hours: null, ipAllowlist: [], invalid: false }

export function policyFromConfig(config: StaffAccessPolicyColumns | null | undefined): StaffAccessPolicy {
  if (!config) return UNRESTRICTED_POLICY
  let invalid = false
  let hours: StaffAccessHours | null = null
  if (config.staffAccessHours !== null && config.staffAccessHours !== undefined) {
    const parsed = parseStaffAccessHours(config.staffAccessHours)
    if (parsed.ok) hours = parsed.hours
    else invalid = true
  }
  const list = parseIpAllowlist(config.staffIpAllowlist ?? [])
  if (!list.ok) invalid = true
  return { hours, ipAllowlist: list.ok ? list.entries : [], invalid }
}

export function isRestricted(policy: StaffAccessPolicy): boolean {
  return policy.invalid || policy.hours !== null || policy.ipAllowlist.length > 0
}

function refusalFor(policy: StaffAccessPolicy, now: Date, ip: string | null): StaffAccessRefusal | null {
  if (policy.invalid) return "policy_invalid"
  if (policy.ipAllowlist.length > 0 && !ipInAllowlist(ip, policy.ipAllowlist)) return "ip_not_allowed"
  if (policy.hours && !isWithinAccessHours(policy.hours, now)) return "outside_hours"
  return null
}

export function evaluateStaffAccess(
  policy: StaffAccessPolicy,
  caller: { role: string; now: Date; ip: string | null },
): StaffAccessDecision {
  const reason = refusalFor(policy, caller.now, caller.ip)
  if (!reason) return { allowed: true }
  if (caller.role === "SUPER_ADMIN") return { allowed: true, bypassed: reason }
  return { allowed: false, reason }
}
