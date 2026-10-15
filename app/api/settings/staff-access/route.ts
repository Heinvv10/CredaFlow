import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { superAdminPolicyWrite } from "@/lib/security/policy-write-guard"
import { parseStaffAccessHours, type StaffAccessHours } from "@/lib/security/staff-access-hours"
import { ipInAllowlist, parseIpAllowlist } from "@/lib/security/ip-allowlist"
import { applyStaffAccessPolicy, type StaffAccessPolicyInput } from "@/lib/security/staff-access-write"

/**
 * The lender's staff working hours and IP allowlist (Settings → Security & KYC
 * policy). Body: { staffAccessHours: {mon..sun} | null, staffIpAllowlist:
 * string[] | string }. null hours / an empty list lift that restriction.
 * SUPER_ADMIN with a TOTP-verified session only; the SUPER_ADMIN is never
 * refused by the policy, so the editor cannot lock themselves out.
 */
export async function PUT(req: NextRequest) {
  return superAdminPolicyWrite(
    req,
    (body, ctx) => {
      const b = (body ?? {}) as { staffAccessHours?: unknown; staffIpAllowlist?: unknown }
      if (!Object.hasOwn(b, "staffAccessHours") || !Object.hasOwn(b, "staffIpAllowlist")) {
        return NextResponse.json({ error: "Submit both staffAccessHours and staffIpAllowlist." }, { status: 400 })
      }
      let hours: StaffAccessHours | null = null
      if (b.staffAccessHours !== null) {
        const parsed = parseStaffAccessHours(b.staffAccessHours)
        if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: "staffAccessHours" }, { status: 422 })
        hours = parsed.hours
      }
      const list = parseIpAllowlist(b.staffIpAllowlist)
      if (!list.ok) return NextResponse.json({ error: list.error, field: "staffIpAllowlist" }, { status: 422 })
      // Without a trusted proxy the app sees no caller address at all
      // (lib/rate-limit.ts callerIp), so an allowlist would refuse everyone.
      if (list.entries.length > 0 && ctx.ip === "unknown") {
        return NextResponse.json({
          error: "This deployment cannot see staff IP addresses (TRUSTED_PROXY is not set), so an allowlist would refuse every staff member except Super Admins.",
          field: "staffIpAllowlist",
        }, { status: 422 })
      }
      return { hours, ipAllowlist: list.entries } satisfies StaffAccessPolicyInput
    },
    async (tx, input, ctx) => {
      const next = input as StaffAccessPolicyInput
      const { changed } = await applyStaffAccessPolicy(tx, {
        tenantId: ctx.tenantId, actor: ctx.actor, next, ipAddress: ctx.ip,
      })
      return NextResponse.json({
        ok: true,
        changed,
        staffAccessHours: next.hours,
        staffIpAllowlist: next.ipAllowlist,
        // The editor is never locked out, but should know if colleagues on
        // their network would be.
        callerIp: ctx.ip,
        callerIpAllowed: next.ipAllowlist.length === 0 || ipInAllowlist(ctx.ip, next.ipAllowlist),
      })
    },
  )
}
