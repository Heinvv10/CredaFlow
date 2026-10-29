/**
 * Deployment checks for the tamper-evident audit (docs/ARCHITECTURE.md). The
 * append-only triggers stop the application; they do not stop a database role that
 * OWNS the tables (an owner can disable its own triggers) or a superuser. So the
 * migration role owns the audit tables and the application connects as a different
 * role that holds INSERT and SELECT on AuditLog and nothing on the evidence tables
 * (audit_grant_runtime). This reports when it does not, and when the HMAC key the
 * chain depends on is missing.
 */
import { prisma } from "@/lib/prisma"
import { auditChainKeyConfigured } from "./chain-hash"

const AUDIT_TABLES = ["AuditLog", "AuditChainLink", "AuditChainCheckpoint", "AuditRedaction", "AuditSiemOutbox"] as const
const EVIDENCE_TABLES = AUDIT_TABLES.filter((t) => t !== "AuditLog")

export type AuditSetupWarning =
  | "audit_runtime_role_owns_tables"
  | "audit_runtime_role_superuser"
  | "audit_runtime_role_can_write_evidence"
  | "audit_chain_key_missing"

interface Queryable { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> }

export async function auditSetupWarnings(db: Queryable = prisma): Promise<AuditSetupWarning[]> {
  const warnings: AuditSetupWarning[] = []
  if (!auditChainKeyConfigured()) warnings.push("audit_chain_key_missing")
  const [row] = await db.$queryRaw<Array<{ owns: number; su: boolean; writes: boolean }>>`
    SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${[...AUDIT_TABLES]}) AND tableowner = current_user) AS owns,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
           (SELECT bool_or(has_table_privilege(current_user, format('public.%I', t), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) FROM unnest(${[...EVIDENCE_TABLES]}::text[]) AS t)
             OR has_table_privilege(current_user, 'public."AuditLog"', 'UPDATE, DELETE, TRUNCATE') AS writes`
  if (row?.owns > 0) warnings.push("audit_runtime_role_owns_tables")
  if (row?.su === true) warnings.push("audit_runtime_role_superuser")
  if (row?.writes === true) warnings.push("audit_runtime_role_can_write_evidence")
  return warnings
}

const MESSAGE: Record<AuditSetupWarning, string> = {
  audit_runtime_role_owns_tables:
    "The application's database role owns the audit tables, so it can switch their append-only triggers off. Run migrations as an owner role and the application as a non-owner (docs/ARCHITECTURE.md, Tamper-evident audit).",
  audit_runtime_role_superuser: "The application's database role is a superuser, which no trigger binds.",
  audit_runtime_role_can_write_evidence:
    "The application's database role holds privileges on the audit evidence tables (or UPDATE/DELETE on AuditLog). Run SELECT audit_grant_runtime('<role>') as the migration role after granting the role its table privileges (docs/ARCHITECTURE.md, Tamper-evident audit).",
  audit_chain_key_missing: "AUDIT_CHAIN_KEY is not set (32+ characters): the audit hash chain cannot be written or verified.",
}

let logged = false

/** Logs each setup problem once per process (called at boot and from /api/health). Never throws. */
export async function warnAuditSetupOnce(): Promise<AuditSetupWarning[]> {
  try {
    const warnings = await auditSetupWarnings()
    if (!logged) for (const w of warnings) console.warn(`[audit] ${MESSAGE[w]}`)
    logged = true
    return warnings
  } catch (error) {
    console.error("[audit] setup check failed:", error)
    return []
  }
}
