/**
 * The per-lender segregation-of-duties (maker-checker) setting:
 * `TenantConfig.requireSegregationOfDuties`, on by default (also for a tenant
 * with no config row).
 *
 * While on, three pairs need two different staff members:
 *   - approving an application / disbursing it (disburse route); where the decision
 *     engine approved it, the staff members whose attestations it rested on take the
 *     approver's place (trigger guardLoanApplicationSegregationOfDuties);
 *   - witnessing the consumer's in-branch signature / countersigning for the
 *     provider (countersign route);
 *   - creating an asset-finance payout / approving it (lib/asset-finance/payout.ts).
 * The routes refuse first with a readable message; the database refuses the
 * same writes (migration 20261016200100_segregation_of_duties). Demo stacks may
 * turn it off (prisma/demo-lender.ts); a real lender keeps the default. Only an
 * ADMIN or SUPER_ADMIN changes it, audited (applySegregationOfDuties).
 */
import { prisma } from "@/lib/prisma"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"

export const SEGREGATION_OF_DUTIES_DEFAULT = true

export const SEGREGATION_OF_DUTIES_REFUSALS = {
  approve_disburse:
    "Segregation of duties: you approved this application, so another staff member must disburse it.",
  attester_disburse:
    "Segregation of duties: the decision engine approved this application on your attestation (reckless-lending assessment, income verification or bureau override), so another staff member must disburse it.",
  branch_sign_countersign:
    "Segregation of duties: you witnessed the client's in-branch signature, so another staff member must countersign for the lender.",
} as const

export type SegregationOfDutiesPair = keyof typeof SEGREGATION_OF_DUTIES_REFUSALS

type ConfigReader = Pick<typeof PrismaClientInstance, "tenantConfig">

export async function isSegregationOfDutiesRequired(tenantId: string, db: ConfigReader = prisma): Promise<boolean> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { requireSegregationOfDuties: true } })
  return config?.requireSegregationOfDuties ?? SEGREGATION_OF_DUTIES_DEFAULT
}

/**
 * Which pair `actorId` would break by taking the next step, or null. Pure, so
 * the application page and the routes ask the same question.
 */
export function segregationOfDutiesConflict(
  step: "disburse" | "countersign",
  actorId: string,
  application: {
    approvedById?: string | null
    /** The approver is the lender's automated decisioning account (User.isSystem). */
    approvedBySystem?: boolean
    recklessLendingAssessedById?: string | null
    incomeVerifiedById?: string | null
    bureauOverrideById?: string | null
    agreementSignedMethod?: string | null
    agreementSignedByUserId?: string | null
  },
): SegregationOfDutiesPair | null {
  if (step === "disburse") {
    if (application.approvedById === actorId) return "approve_disburse"
    // The engine approved it, so no person approved: the people whose attestations it rested on take the approver's place.
    if (application.approvedBySystem === true && actorId !== "") {
      const attesters = [application.recklessLendingAssessedById, application.incomeVerifiedById, application.bureauOverrideById]
      if (attesters.includes(actorId)) return "attester_disburse"
    }
    return null
  }
  return application.agreementSignedMethod === "branch" && application.agreementSignedByUserId === actorId
    ? "branch_sign_countersign"
    : null
}

export type SegregationOfDutiesState = {
  required: boolean
  /** The latest change, from its audit row; null when never changed. */
  lastChange: { at: Date; byEmail: string | null } | null
}

export async function getSegregationOfDutiesState(tenantId: string): Promise<SegregationOfDutiesState> {
  const [required, last] = await Promise.all([
    isSegregationOfDutiesRequired(tenantId),
    prisma.auditLog.findFirst({
      where: { tenantId, action: AuditAction.SEGREGATION_OF_DUTIES_POLICY_UPDATED, entity: "TenantConfig", entityId: tenantId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, userEmail: true },
    }),
  ])
  return { required, lastChange: last ? { at: last.createdAt, byEmail: last.userEmail } : null }
}

type PolicyTx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

/**
 * Set the flag inside the caller's transaction (which has already checked the
 * actor's role). The change and its audit row commit together; an unchanged
 * value writes and audits nothing.
 */
export async function applySegregationOfDuties(
  tx: PolicyTx,
  args: { tenantId: string; actor: { id: string; email: string }; required: boolean; ipAddress?: string },
): Promise<{ changed: boolean; required: boolean }> {
  const { tenantId, actor, required, ipAddress } = args
  // With no config row there is nothing to lock: serialise first writers too.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`segregation-of-duties:${tenantId}`}))`
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const previous = await isSegregationOfDutiesRequired(tenantId, tx)
  if (previous === required) return { changed: false, required }

  await tx.tenantConfig.upsert({
    where: { tenantId },
    update: { requireSegregationOfDuties: required },
    create: { tenantId, requireSegregationOfDuties: required },
  })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.SEGREGATION_OF_DUTIES_POLICY_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: { requireSegregationOfDuties: previous },
    newValue: { requireSegregationOfDuties: required },
    ipAddress,
  }, tx)
  return { changed: true, required }
}
