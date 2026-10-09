/**
 * /compliance carries the NCA and POPIA duties of a registered credit provider
 * — the NCR quarterly return, the Section 129 register, DSAR and complaints.
 *
 * It previously redirected to /dashboard unless `featureIms` was on, because
 * the sidebar happened to list it inside the insurance nav group. Switching the
 * insurance module off therefore hid a lender's statutory obligations, which is
 * exactly backwards: those duties exist whether or not the tenant sells cover.
 * The nav group has been split to match (see lib/navigation.ts).
 *
 * Access control has not been loosened: `featureIms` was a module switch, never
 * a role check. The floor is unchanged — the (dashboard) layout still requires
 * an authenticated, non-CLIENT staff session — and every page beneath this one
 * carries its own guard on top: READONLY on the dashboard and both quarterly
 * returns, LOAN_ADMIN on bureau overrides, the breach log, COI and TCF, ADMIN
 * on DSAR. Each API route repeats the check with `requireApiRole`. The FSCA
 * return had no guard of its own and has been given one rather than left
 * leaning on a redirect that no longer exists.
 */
export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
