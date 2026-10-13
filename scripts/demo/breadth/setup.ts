/**
 * The lender's one-off configuration before its first business day, done the
 * way its people would (every call idempotent, so a resumed bake can repeat it):
 *
 *   1. Settings → Users: the breadth staff (breadth/staff.ts), TOTP-enrolled;
 *      the platform operator is bootstrapped with the stack instead.
 *   2. Settings → Branches (POST /api/branches): Sandton head office and the
 *      Pretoria branch, each with its manager; staff are then placed in their
 *      branch (PATCH /api/settings/users/[id]). Branches have no edit route, so
 *      the manager must exist before the branch.
 *   3. The platform operator switches on the CRM and bureau-submission modules
 *      and the bureau supplier details (PATCH /api/admin/tenants/[id],
 *      SUPER_ADMIN + x-admin-secret; `enableOperatorModules`, its own event).
 *      Reporting starts on the window's first day.
 *   4. Settings → Insurance (PATCH /api/settings/ims): the insurance module.
 *   5. Settings → Referral commission: the tenant's default rate.
 *   6. Inbox roster (PATCH /api/inbox/roster): the staff who answer client
 *      conversations. Below ADMIN only rostered "comms agents" may work a thread.
 *   7. Settings → Lender identity → Logo (POST /api/settings/identity/logo,
 *      audited, needs the TOTP-verified admin): the PNG at DEMO_LENDER_LOGO,
 *      when set. The seed already wrote the rest of DEMO_LENDER's identity and
 *      its colours; a logo is a brand asset, so it is never in git.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { demoLender } from "../../../prisma/demo-lender"
import { log, simEnv } from "../sim/env"
import { as, staffOf, type Breadth } from "./context"
import { ensureBreadthStaff, STAFF, type StaffKey } from "./staff"

interface BranchRow {
  id: string
  code: string
}

const BRANCHES = [
  { code: "SAN", name: "Sandton Head Office", address: "1 Main Road, Sandton, 2196", phone: "+27110000000" },
  { code: "PTA", name: "Pretoria Branch", address: "212 Pretorius Street, Pretoria Central, 0002", phone: "+27120000000" },
] as const

/** Bureau supplier details as the lender's SACRRA membership assigns them (fictional). */
const BUREAU = demoLender().bureau

/** Tenant default referral commission: 2% of principal. */
const REFERRAL_COMMISSION_BPS = 200

async function ensureBranches(b: Breadth): Promise<Record<string, string>> {
  const admin = b.sim.actors.admin
  const managers: Record<string, string> = {
    SAN: admin.user?.id ?? "",
    PTA: staffOf(b).branchManager.creds.userId,
  }
  const existing = (await admin.get<BranchRow[]>("/api/branches")).json ?? []
  const ids: Record<string, string> = {}
  for (const br of BRANCHES) {
    const found = existing.find((x) => x.code === br.code)
    if (found) {
      ids[br.code] = found.id
      continue
    }
    const created = await admin.post<BranchRow>("/api/branches", { ...br, managerId: managers[br.code] || undefined }, { expect: [201] })
    if (!created.json?.id) throw new Error(`branch ${br.code} create returned no id`)
    ids[br.code] = created.json.id
    log(`Settings → Branches: ${br.name}`)
  }
  return ids
}

async function placeStaff(b: Breadth, branchIds: Record<string, string>): Promise<void> {
  const admin = b.sim.actors.admin
  const users = (await admin.get<{ users: Array<{ id: string; email: string; branchId: string | null }> }>("/api/settings/users")).json?.users ?? []
  const placements: Array<{ userId: string; branchId: string }> = []
  for (const key of Object.keys(STAFF) as StaffKey[]) {
    const branch = STAFF[key].branch
    if (branch) placements.push({ userId: staffOf(b)[key].creds.userId, branchId: branchIds[branch] })
  }
  // The seed's credit officer and the collections manager work at head office.
  for (const email of [b.sim.actors.creds.officer.email, b.sim.actors.loanAdminCreds.email]) {
    const user = users.find((u) => u.email === email)
    if (user) placements.push({ userId: user.id, branchId: branchIds.SAN })
  }
  for (const p of placements) {
    if (users.find((u) => u.id === p.userId)?.branchId === p.branchId) continue
    await admin.patch(`/api/settings/users/${p.userId}`, { branchId: p.branchId })
  }
}

/**
 * The platform operator's step, its own event a few minutes after runSetup.
 * The operator is bootstrapped with the stack (sim/provision-operator.ts), not
 * created in runSetup.
 */
export async function enableOperatorModules(b: Breadth): Promise<void> {
  const operator = await as(b, "operator")
  const tenantId = operator.user?.tenantId
  if (!tenantId) throw new Error("the operator session carries no tenant id")
  await operator.patch(`/api/admin/tenants/${tenantId}`, {
    featureCrm: true,
    featureBureauSubmission: true,
    bureauSupplierNumber: BUREAU.supplierNumber,
    bureauTradingName: BUREAU.tradingName,
    bureauReportingStartDate: b.sim.window.start,
  }, { headers: { "x-admin-secret": simEnv("ADMIN_SECRET") } })
  log("platform operator: CRM and bureau submission switched on")
}

async function enableSettings(b: Breadth): Promise<void> {
  const admin = b.sim.actors.admin
  await admin.patch("/api/settings/ims", { featureIms: true })
  await admin.patch("/api/settings/referral-commission", { referralCommissionBps: REFERRAL_COMMISSION_BPS })
  log(`Settings → Insurance on; referral commission ${REFERRAL_COMMISSION_BPS / 100}%`)
}

async function rosterInbox(b: Breadth): Promise<void> {
  const admin = b.sim.actors.admin
  const users = (await admin.get<{ users: Array<{ id: string; email: string }> }>("/api/settings/users")).json?.users ?? []
  const emails = [b.sim.actors.creds.officer.email, b.sim.actors.loanAdminCreds.email, STAFF.officer2.email, STAFF.branchManager.email, STAFF.insurance.email]
  for (const email of emails) {
    const user = users.find((u) => u.email === email)
    if (!user) throw new Error(`inbox roster: no user ${email}`)
    await admin.patch("/api/inbox/roster", { userId: user.id, isCommsAgent: true })
  }
  log(`inbox roster: ${emails.length} comms agents`)
}

async function uploadLogo(b: Breadth): Promise<void> {
  const file = process.env.DEMO_LENDER_LOGO
  if (!file) return
  await b.sim.actors.admin.post("/api/settings/identity/logo", new Uint8Array(readFileSync(file)), { headers: { "content-type": "image/png" }, expect: [200] })
  log(`Settings → Lender identity: logo ${path.basename(file)}`)
}

export async function runSetup(b: Breadth): Promise<void> {
  b.staff = await ensureBreadthStaff(b.sim.actors.admin)
  const branchIds = await ensureBranches(b)
  await placeStaff(b, branchIds)
  await enableSettings(b)
  await rosterInbox(b)
  await uploadLogo(b)
}
