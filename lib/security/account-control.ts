/**
 * Two people, not two accounts: the one rule every two-person control shares (F12; the inventory is in account-control-census.test.ts).
 * The approver and the maker must not stand in a control relation over the last 30 days: neither created or changed the other's account,
 * directly or through accounts minted in that window (the maker mints S1, S1 mints S2, S2 approves). Two accounts with a common creator
 * are not related by that alone: a lender's first admin sets up the whole team, and those people check each other's work.
 *
 * The trail is the audit log the staff, SSO and TOTP routes write. An operator-provisioned, bootstrap or seeded account leaves no such row
 * (or names a principal who is not the lender's staff), so it is exempt. Refusing a request is not gated: this holds the approving act.
 * lib/maker-checker adds, for configuration, the rules on the maker account itself (a new account, a recent takeover).
 */
import { AuditAction } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"

export const ACCOUNT_CONTROL_DAYS = 30
export const ACCOUNT_CONTROL_REFUSAL = `Two people, not two accounts: one of you created or changed the other's account in the last ${ACCOUNT_CONTROL_DAYS} days, so another person must decide this.`

const CONTROL_ACTIONS = [AuditAction.USER_CREATED, AuditAction.USER_UPDATED, AuditAction.TOTP_RESET_BY_ADMIN]
/** A chain of accounts minting accounts longer than this inside one window is not walked further. */
const MAX_MINT_HOPS = 8

type Db = Pick<typeof prisma, "auditLog">

/** The accounts and everyone who minted them in the window, up the chain. */
async function mintLine(db: Db, tenantId: string, ids: readonly string[], since: Date): Promise<string[]> {
  const line = new Set(ids)
  let frontier = [...ids]
  for (let hop = 0; hop < MAX_MINT_HOPS && frontier.length > 0; hop += 1) {
    const rows = await db.auditLog.findMany({
      where: { tenantId, entity: "User", action: AuditAction.USER_CREATED, entityId: { in: frontier }, userId: { not: null }, createdAt: { gte: since } },
      select: { userId: true },
    })
    frontier = [...new Set(rows.flatMap((r) => (r.userId && !line.has(r.userId) ? [r.userId] : [])))]
    for (const id of frontier) line.add(id)
  }
  return [...line]
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
  const [checkerLine, makerLine] = await Promise.all([mintLine(db, tenantId, [checkerId], since), mintLine(db, tenantId, makers, since)])
  const row = await db.auditLog.findFirst({
    where: {
      tenantId, entity: "User", action: { in: CONTROL_ACTIONS }, createdAt: { gte: since },
      OR: [{ userId: { in: makers }, entityId: { in: checkerLine } }, { userId: checkerId, entityId: { in: makerLine } }],
    },
    select: { id: true },
  })
  return row ? ACCOUNT_CONTROL_REFUSAL : null
}
