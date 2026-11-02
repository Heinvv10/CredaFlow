/**
 * Two people, not two accounts: the one rule every two-person control shares (F12; the inventory is in account-control-census.test.ts).
 * An approver and a maker may not sit opposite each other when, in the last 30 days:
 *  - either holds the other's account, directly or up a line of accounts: they created it or changed its access (role, email, password, branch,
 *    activation, a second-factor reset), or the account came through an SSO connection they configured (a JIT or linked account opposite whoever set
 *    the connection up, whenever they did). The maker mints S1, S1 mints S2, S2 approves: refused. A phone, a name or an inbox tick is no hold;
 *  - one person holds the credentials of both: created them both, or reset the email, password or second factor of both, or any mix. This line
 *    leaves out role, branch and activation changes, which do not hand anyone the account: an admin placing the team on branches separates nobody.
 *
 * The trail is the audit log the staff, SSO and TOTP routes write. An operator-provisioned, bootstrap or seeded account leaves no such row (or names
 * a principal who is not the lender's staff), so it is exempt. A line too long to walk is refused, never passed unread. Refusing a request is not
 * gated: this holds the approving act. lib/maker-checker adds, for configuration, the rules on the maker account itself.
 */
import { AuditAction } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"

export const ACCOUNT_CONTROL_DAYS = 30
export const ACCOUNT_CONTROL_REFUSAL = `Two people, not two accounts: one of you created or changed the other's account in the last ${ACCOUNT_CONTROL_DAYS} days, or the same person set up both, so another person must decide this.`
export const ACCOUNT_CONTROL_UNREADABLE = "Two people, not two accounts: the record of who set up these accounts is too long to check, so another person must decide this."

const CONTROL_ACTIONS = [AuditAction.USER_CREATED, AuditAction.USER_UPDATED, AuditAction.TOTP_RESET_BY_ADMIN]
/** How an account comes through an SSO connection: each row names the account itself, so the hold is read from who configured the connection. */
const SSO_ACTIONS: readonly string[] = [AuditAction.SSO_USER_PROVISIONED, AuditAction.SSO_IDENTITY_LINKED, AuditAction.SSO_ROLE_SYNCED]
/** A line of accounts longer than this inside one window is not walked further: the rule then refuses. */
const MAX_HOPS = 8

type Db = Pick<typeof prisma, "auditLog">
const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** What on a USER_UPDATED row changes how someone signs in or what they may do: role, email, password. */
export function changesSignInOrRole(row: { oldValue: unknown; newValue: unknown }): boolean {
  const before = asObject(row.oldValue)
  const after = asObject(row.newValue)
  return "role" in before || "role" in after || "email" in before || "email" in after || after.passwordChanged === true
}

type Row = { action: string; oldValue: unknown; newValue: unknown }

/** Whether a USER_UPDATED row changed activation: the value itself, or on an older row only the names of what changed. */
const changesActivation = (row: Row) => "active" in asObject(row.oldValue) || "active" in asObject(row.newValue)
  || (Array.isArray(asObject(row.newValue).changed) && (asObject(row.newValue).changed as unknown[]).includes("active"))

/** A row that hands its writer the account's credentials: creating it, a second-factor reset, a new email or password. */
function givesCredentials(row: Row): boolean {
  if (row.action === AuditAction.USER_CREATED || row.action === AuditAction.TOTP_RESET_BY_ADMIN) return true
  if (row.action !== AuditAction.USER_UPDATED) return false
  const before = asObject(row.oldValue)
  const after = asObject(row.newValue)
  return "email" in before || "email" in after || after.passwordChanged === true
}

/** A row that hands its writer a hold over the account: its credentials, or its role, branch (which carries approval authority) or activation. */
function givesControl(row: Row): boolean {
  if (givesCredentials(row)) return true
  if (row.action !== AuditAction.USER_UPDATED) return false
  return changesSignInOrRole(row) || "branchId" in asObject(row.oldValue) || "branchId" in asObject(row.newValue) || changesActivation(row)
}

/** The accounts and everyone holding them in the window, up the line. `truncated`: the walk stopped with accounts still unread. */
async function line(db: Db, tenantId: string, ids: readonly string[], since: Date, edge: (row: Row) => boolean, sso: boolean): Promise<{ ids: string[]; truncated: boolean }> {
  const seen = new Set(ids)
  let frontier = [...ids]
  const actions = sso ? [...CONTROL_ACTIONS, ...SSO_ACTIONS] : CONTROL_ACTIONS
  for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop += 1) {
    const rows = await db.auditLog.findMany({
      where: { tenantId, entity: "User", action: { in: actions }, entityId: { in: frontier }, userId: { not: null }, createdAt: { gte: since } },
      select: { userId: true, entityId: true, action: true, oldValue: true, newValue: true },
    })
    const holders = rows.flatMap((r) => (r.userId && r.userId !== r.entityId && edge(r) ? [r.userId] : []))
    if (rows.some((r) => SSO_ACTIONS.includes(r.action))) {
      const editors = await db.auditLog.findMany({ where: { tenantId, action: AuditAction.SSO_CONNECTION_UPDATED, userId: { not: null } }, select: { userId: true } })
      for (const row of editors) if (row.userId) holders.push(row.userId)
    }
    frontier = [...new Set(holders.filter((id) => !seen.has(id)))]
    for (const id of frontier) seen.add(id)
  }
  return { ids: [...seen], truncated: frontier.length > 0 }
}

/**
 * Why \`checkerId\` may not sit opposite \`makerIds\` on a two-person control, or null. A maker id may be null (a feed-recorded rate has no
 * requester) or the checker itself (each control refuses that case with its own words).
 */
export async function accountControlRefusal(
  db: Db,
  input: { tenantId: string; makerIds: ReadonlyArray<string | null | undefined>; checkerId: string; now?: Date },
): Promise<string | null> {
  const { tenantId, checkerId } = input
  const makers = [...new Set(input.makerIds.flatMap((id) => (id && id !== checkerId ? [id] : [])))]
  if (makers.length === 0) return null
  const since = new Date((input.now ?? new Date()).getTime() - ACCOUNT_CONTROL_DAYS * 86_400_000)
  const [checkerHolds, makerHolds, checkerKeys, makerKeys] = await Promise.all([
    line(db, tenantId, [checkerId], since, givesControl, true), line(db, tenantId, makers, since, givesControl, true),
    line(db, tenantId, [checkerId], since, givesCredentials, false), line(db, tenantId, makers, since, givesCredentials, false),
  ])
  if (checkerHolds.truncated || makerHolds.truncated) return ACCOUNT_CONTROL_UNREADABLE
  if (makers.some((id) => checkerHolds.ids.includes(id)) || makerHolds.ids.includes(checkerId)) return ACCOUNT_CONTROL_REFUSAL
  return makerKeys.ids.some((id) => checkerKeys.ids.includes(id)) ? ACCOUNT_CONTROL_REFUSAL : null
}
