/**
 * Two people, not two accounts: the one rule every two-person control shares (F12; the inventory is in account-control-census.test.ts).
 * An approver and a maker may not sit opposite each other when, in the last 30 days:
 *  - either created the other's account or changed its access, directly or through a line of accounts (the maker mints S1, S1 mints S2, S2
 *    approves; the maker takes over S1 and S1 resets S2). Access is role, email, password, branch and a second-factor reset: a phone number,
 *    a name or an inbox-roster tick keeps nobody apart;
 *  - they share a creator and either of them is under 30 days old (the same person minted both, or a new account beside an older one).
 *
 * The trail is the audit log the staff, SSO and TOTP routes write. An operator-provisioned, bootstrap or seeded account leaves no such row
 * (or names a principal who is not the lender's staff), so it is exempt. A line too long to walk is refused, never passed unread. Refusing a
 * request is not gated: this holds the approving act. lib/maker-checker adds, for configuration, the rules on the maker account itself.
 */
import { AuditAction } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"

export const ACCOUNT_CONTROL_DAYS = 30
export const ACCOUNT_CONTROL_REFUSAL = `Two people, not two accounts: one of you created or changed the other's account in the last ${ACCOUNT_CONTROL_DAYS} days, or the same person created you both, so another person must decide this.`
export const ACCOUNT_CONTROL_UNREADABLE = "Two people, not two accounts: the record of who set up these accounts is too long to check, so another person must decide this."

const CONTROL_ACTIONS = [AuditAction.USER_CREATED, AuditAction.USER_UPDATED, AuditAction.TOTP_RESET_BY_ADMIN]
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

/** A row that hands someone a hold over an account: creating it, a second-factor reset, or an update of its sign-in, role or branch (a branch carries approval authority). */
function givesControl(row: { action: string; oldValue: unknown; newValue: unknown }): boolean {
  if (row.action === AuditAction.USER_CREATED || row.action === AuditAction.TOTP_RESET_BY_ADMIN) return true
  if (row.action !== AuditAction.USER_UPDATED) return false
  return changesSignInOrRole(row) || "branchId" in asObject(row.oldValue) || "branchId" in asObject(row.newValue)
}

/** The accounts and everyone with a hold over them in the window, up the line. `truncated`: the walk stopped with accounts still unread. */
async function controlLine(db: Db, tenantId: string, ids: readonly string[], since: Date): Promise<{ line: string[]; truncated: boolean }> {
  const line = new Set(ids)
  let frontier = [...ids]
  for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop += 1) {
    const rows = await db.auditLog.findMany({
      where: { tenantId, entity: "User", action: { in: CONTROL_ACTIONS }, entityId: { in: frontier }, userId: { not: null }, createdAt: { gte: since } },
      select: { userId: true, entityId: true, action: true, oldValue: true, newValue: true },
    })
    frontier = [...new Set(rows.flatMap((r) => (r.userId && r.userId !== r.entityId && !line.has(r.userId) && givesControl(r) ? [r.userId] : [])))]
    for (const id of frontier) line.add(id)
  }
  return { line: [...line], truncated: frontier.length > 0 }
}

/**
 * Who created an account (and, while each creation is inside the window, who created them), and whether the account itself is under the
 * window old. Any chain of creations inside the window has already been walked by controlLine, which refuses one too long to read.
 */
async function creators(db: Db, tenantId: string, id: string, since: Date): Promise<{ ids: Set<string>; young: boolean }> {
  const ids = new Set<string>()
  let young = false
  let frontier = [id]
  for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop += 1) {
    const rows = await db.auditLog.findMany({
      where: { tenantId, entity: "User", action: AuditAction.USER_CREATED, entityId: { in: frontier }, userId: { not: null } },
      select: { userId: true, createdAt: true },
    })
    const recent = rows.filter((r) => r.createdAt >= since)
    if (hop === 0) young = recent.length > 0
    for (const r of rows) if (r.userId) ids.add(r.userId)
    frontier = [...new Set(recent.flatMap((r) => (r.userId && r.userId !== id ? [r.userId] : [])))]
  }
  return { ids, young }
}

/**
 * Why `checkerId` may not sit opposite `makerIds` on a two-person control, or null. A maker id may be null (a feed-recorded rate has no
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
  const [checkerSide, makerSide] = await Promise.all([controlLine(db, tenantId, [checkerId], since), controlLine(db, tenantId, makers, since)])
  if (checkerSide.truncated || makerSide.truncated) return ACCOUNT_CONTROL_UNREADABLE
  const rows = await db.auditLog.findMany({
    where: {
      tenantId, entity: "User", action: { in: CONTROL_ACTIONS }, createdAt: { gte: since },
      OR: [{ userId: { in: makers }, entityId: { in: checkerSide.line } }, { userId: checkerId, entityId: { in: makerSide.line } }],
    },
    select: { action: true, oldValue: true, newValue: true },
  })
  if (rows.some(givesControl)) return ACCOUNT_CONTROL_REFUSAL
  const checker = await creators(db, tenantId, checkerId, since)
  for (const maker of makers) {
    const other = await creators(db, tenantId, maker, since)
    if ((checker.young || other.young) && [...other.ids].some((id) => checker.ids.has(id))) return ACCOUNT_CONTROL_REFUSAL
  }
  return null
}
