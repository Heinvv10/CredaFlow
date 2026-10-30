/**
 * The application half of "one jurisdiction per instance". The database holds
 * the instance's jurisdiction in one row (InstanceJurisdiction) and triggers
 * (migration 20261029120000_instance_jurisdiction) refuse any lender whose
 * TenantConfig differs from it. These helpers let a provisioning, activation or
 * reactivation path say so with a clean 409 before the trigger would, and turn
 * the trigger's error into the same 409.
 */

export interface InstanceValue {
  jurisdiction: string
  currency: string
}

/** The slice of Prisma these checks use: satisfied by the app client, a transaction and the CLI's plain client. */
type Db = {
  instanceJurisdiction: {
    findUnique: (args: { where: { id: 1 } }) => Promise<InstanceValue | null>
  }
  tenantConfig: {
    findUnique: (args: { where: { tenantId: string }; select: { jurisdiction: true; currency: true } }) => Promise<InstanceValue | null>
  }
}

export interface InstanceConflict {
  message: string
}

const describe = (v: InstanceValue) => `${v.jurisdiction}/${v.currency}`

/** The instance's jurisdiction and currency, or null on a database that is not migrated. */
export function readInstanceJurisdiction(db: Pick<Db, "instanceJurisdiction">): Promise<InstanceValue | null> {
  return db.instanceJurisdiction.findUnique({ where: { id: 1 } })
}

/** Null when a lender with this jurisdiction and currency belongs on this instance. */
export async function instanceJurisdictionConflict(db: Pick<Db, "instanceJurisdiction">, subject: InstanceValue): Promise<InstanceConflict | null> {
  const instance = await readInstanceJurisdiction(db)
  if (!instance || describe(instance) === describe(subject)) return null
  return {
    message: `One instance serves one jurisdiction: this instance is ${describe(instance)}, this lender is ${describe(subject)}. Give it its own instance and database.`,
  }
}

/** The same check for an existing tenant about to become ACTIVE: its stored config is the subject. */
export async function activationConflict(db: Db, tenantId: string): Promise<InstanceConflict | null> {
  const own = await db.tenantConfig.findUnique({ where: { tenantId }, select: { jurisdiction: true, currency: true } })
  // No config yet: its config is checked when it is created.
  if (!own) return null
  return instanceJurisdictionConflict(db, own)
}

/** True for the check violation the instance-jurisdiction triggers raise. */
export function isInstanceJurisdictionError(error: unknown): error is Error {
  return error instanceof Error && /One instance serves one jurisdiction/.test(error.message)
}

/** The message of that error without Prisma's query noise. */
export function instanceJurisdictionMessage(error: Error): string {
  const m = /One instance serves one jurisdiction[^]*?(?:database\.)/.exec(error.message)
  return m ? m[0] : "One instance serves one jurisdiction; give this lender its own instance and database."
}
