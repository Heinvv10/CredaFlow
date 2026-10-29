/**
 * The application half of "one jurisdiction per instance". The database
 * (migration 20261029110000_jurisdiction_instance_guard) refuses any state where
 * two ACTIVE tenants differ in jurisdiction or currency; these helpers let a
 * provisioning, activation or reactivation path say so with a clean 409 before
 * the trigger would, and turn the trigger's error into the same 409.
 */
/** The slice of Prisma these checks use: satisfied by the app client, a transaction and the CLI's plain client. */
type Db = {
  tenantConfig: {
    findMany: (args: {
      where: { tenant: { status: "ACTIVE" }; tenantId?: { not: string } }
      select: { jurisdiction: true; currency: true; tenant: { select: { slug: true } } }
    }) => Promise<Array<{ jurisdiction: string; currency: string; tenant: { slug: string } }>>
    findUnique: (args: {
      where: { tenantId: string }
      select: { jurisdiction: true; currency: true }
    }) => Promise<{ jurisdiction: string; currency: string } | null>
  }
}

export interface InstanceConflict {
  /** "slug=LS/LSL" of an ACTIVE tenant that disagrees. */
  other: string
  message: string
}

const describe = (jurisdiction: string, currency: string) => `${jurisdiction}/${currency}`

/**
 * Null when a tenant that is (or would become) ACTIVE with this jurisdiction
 * and currency agrees with every other ACTIVE tenant on the instance.
 */
export async function instanceJurisdictionConflict(
  db: Db,
  subject: { tenantId: string | null; jurisdiction: string; currency: string },
): Promise<InstanceConflict | null> {
  const others = await db.tenantConfig.findMany({
    where: { tenant: { status: "ACTIVE" }, ...(subject.tenantId ? { tenantId: { not: subject.tenantId } } : {}) },
    select: { jurisdiction: true, currency: true, tenant: { select: { slug: true } } },
  })
  const clash = others.find((o) => o.jurisdiction !== subject.jurisdiction || o.currency !== subject.currency)
  if (!clash) return null
  const other = `${clash.tenant.slug}=${describe(clash.jurisdiction, clash.currency)}`
  return {
    other,
    message: `One instance serves one jurisdiction: an ACTIVE lender here is ${other}, this one is ${describe(subject.jurisdiction, subject.currency)}. Give it its own instance and database.`,
  }
}

/** The same check for an existing tenant that is about to become ACTIVE: its stored config is the subject. */
export async function activationConflict(db: Db, tenantId: string): Promise<InstanceConflict | null> {
  const own = await db.tenantConfig.findUnique({ where: { tenantId }, select: { jurisdiction: true, currency: true } })
  // No config yet: its config will be checked when it is created.
  if (!own) return null
  return instanceJurisdictionConflict(db, { tenantId, jurisdiction: own.jurisdiction, currency: own.currency })
}

/** True for the check violation the instance-jurisdiction trigger raises. */
export function isInstanceJurisdictionError(error: unknown): error is Error {
  return error instanceof Error && /One instance serves one jurisdiction/.test(error.message)
}

/** The message of that error without Prisma's query noise. */
export function instanceJurisdictionMessage(error: Error): string {
  const m = /One instance serves one jurisdiction[^]*?(?:database\.)/.exec(error.message)
  return m ? m[0] : "One instance serves one jurisdiction; give this lender its own instance and database."
}
