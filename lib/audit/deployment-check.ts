/**
 * Deployment checks for the tamper-evident audit (docs/ARCHITECTURE.md). The
 * append-only triggers stop the application; they do not stop a database role that
 * OWNS the tables (an owner can disable its own triggers), a superuser, or a role that
 * can create roles or objects. So the migration role owns the audit tables, the WEB login
 * holds INSERT and SELECT on AuditLog plus audit_policy_save and nothing else, and the WORKER
 * login (the process that runs the crons) holds the chainer, verifier and delivery functions
 * (audit_grant_web / audit_grant_worker). This reports when it does not, and when the HMAC key
 * the chain depends on is missing from the worker or present on the web. In production the
 * serious ones REFUSE to start the process (auditSetupRefusal), unless an operator who knows
 * sets AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 (the synthetic demo stacks do).
 */
import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/observability/logger"
import { cronSchedulerEnabled } from "@/lib/ops/cron-scheduler-flag"
import { auditChainKeyConfigured } from "./chain-hash"

const AUDIT_TABLES = [
  "AuditLog", "AuditChainLink", "AuditChainCheckpoint", "AuditRedaction", "AuditSiemOutbox", "AuditPolicyRevision", "AuditSiemDelivery", "AuditChainRepair", "AuditSiemLease",
] as const
const EVIDENCE_TABLES = AUDIT_TABLES.filter((t) => t !== "AuditLog")

export type AuditSetupWarning =
  | "audit_runtime_role_owns_tables"
  | "audit_runtime_role_superuser"
  | "audit_runtime_role_privileged"
  | "audit_runtime_role_can_write_evidence"
  | "audit_web_holds_worker_functions"
  | "audit_chain_key_missing"
  | "audit_chain_key_on_web"

/** Warnings that make a production process refuse to start. */
const REFUSED = new Set<AuditSetupWarning>([
  "audit_runtime_role_owns_tables", "audit_runtime_role_superuser", "audit_runtime_role_privileged", "audit_runtime_role_can_write_evidence",
])

interface Queryable { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> }

/** True where this process runs the crons (the worker): it holds AUDIT_CHAIN_KEY and the worker functions. */
function isWorker(env: Partial<Record<string, string>> = process.env): boolean {
  return cronSchedulerEnabled(env) && (env.APP_MODE ?? "all") !== "client"
}

export async function auditSetupWarnings(db: Queryable = prisma, env: Partial<Record<string, string>> = process.env): Promise<AuditSetupWarning[]> {
  const warnings: AuditSetupWarning[] = []
  const worker = isWorker(env)
  const keyed = (env.AUDIT_CHAIN_KEY ?? "").length >= 32
  if (worker && !keyed) warnings.push("audit_chain_key_missing")
  if (!worker && keyed) warnings.push("audit_chain_key_on_web")
  const [row] = await db.$queryRaw<Array<{ owns: number; su: boolean; privileged: boolean; writes: boolean; workerFns: boolean }>>`
    SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${[...AUDIT_TABLES]}) AND pg_has_role(current_user, tableowner, 'MEMBER'))
             + (SELECT CASE WHEN pg_has_role(current_user, 'audit_redactor', 'MEMBER') THEN 1 ELSE 0 END) AS owns,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
           (SELECT rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user) OR has_schema_privilege(current_user, 'public', 'CREATE') AS privileged,
           (SELECT COALESCE(bool_or(has_table_privilege(current_user, format('public.%I', t), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')), false) FROM unnest(${[...EVIDENCE_TABLES]}::text[]) AS t)
             OR has_table_privilege(current_user, 'public."AuditLog"', 'UPDATE, DELETE, TRUNCATE') AS writes,
           COALESCE(has_function_privilege(current_user, to_regprocedure('public.audit_chain_append(text,jsonb)'), 'EXECUTE'), false) AS "workerFns"`
  if (row?.owns > 0) warnings.push("audit_runtime_role_owns_tables")
  if (row?.su === true) warnings.push("audit_runtime_role_superuser")
  if (row?.privileged === true) warnings.push("audit_runtime_role_privileged")
  if (row?.writes === true) warnings.push("audit_runtime_role_can_write_evidence")
  if (!worker && row?.workerFns === true) warnings.push("audit_web_holds_worker_functions")
  return warnings
}

/**
 * The warnings that must stop a production process from starting: null when it may start (not
 * production, nothing serious, or AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1).
 */
export function auditSetupRefusal(warnings: readonly AuditSetupWarning[], env: Partial<Record<string, string>> = process.env): AuditSetupWarning[] | null {
  if (env.NODE_ENV !== "production" || env.AUDIT_ALLOW_PRIVILEGED_DB_ROLE === "1") return null
  const serious = warnings.filter((w) => REFUSED.has(w))
  return serious.length > 0 ? serious : null
}

const MESSAGE: Record<AuditSetupWarning, string> = {
  audit_runtime_role_owns_tables:
    "The application's database role owns an audit table or the redaction function, or is a member of a role that does, so it can switch the append-only triggers off or redact. Run migrations as an owner role and the application as a non-owner (docs/ARCHITECTURE.md, Tamper-evident audit).",
  audit_runtime_role_superuser: "The application's database role is a superuser, which no trigger binds.",
  audit_runtime_role_privileged: "The application's database role can create roles or databases, or holds CREATE on schema public: it could create objects that shadow or bypass the audit functions.",
  audit_runtime_role_can_write_evidence:
    "The application's database role holds privileges on the audit evidence tables (or UPDATE/DELETE on AuditLog). Run SELECT audit_grant_web('<role>') (web) or audit_grant_worker('<role>') (worker) as the migration role after granting the role its table privileges (docs/ARCHITECTURE.md, Tamper-evident audit).",
  audit_web_holds_worker_functions:
    "This web process's database login can call the audit chainer and outbox functions. Give the web login audit_grant_web and the worker its own login with audit_grant_worker (docs/ARCHITECTURE.md); a single login for both is the weaker single-process shape.",
  audit_chain_key_missing: "AUDIT_CHAIN_KEY is not set (32+ characters) on the process that runs the crons: the audit hash chain cannot be written or verified.",
  audit_chain_key_on_web: "AUDIT_CHAIN_KEY is set on a process that does not run the crons. Only the worker needs it; leaving it on the web process lets a compromised web server forge the chain.",
}

let logged = false

/** Logs each setup problem once per process (called at boot and from /api/health). Never throws. */
export async function warnAuditSetupOnce(): Promise<AuditSetupWarning[]> {
  try {
    const warnings = await auditSetupWarnings()
    if (!logged) for (const w of warnings) logger.warn(`[audit] ${MESSAGE[w]}`, { warning: w })
    logged = true
    return warnings
  } catch (error) {
    logger.error("[audit] setup check failed", { error })
    return []
  }
}

/** At boot: warn, and exit where a production process must not run with this role (see auditSetupRefusal). */
export async function enforceAuditSetupAtBoot(): Promise<void> {
  const warnings = await warnAuditSetupOnce()
  const refused = auditSetupRefusal(warnings)
  if (refused) {
    logger.error("[audit] refusing to start: the database role could undo the audit protections (set AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 only on a stack that accepts that)", { warnings: refused })
    process.exit(1)
  }
}

export { auditChainKeyConfigured }
