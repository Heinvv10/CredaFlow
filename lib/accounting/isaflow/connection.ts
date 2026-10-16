/**
 * A tenant's IsaFlow connection: one company, reached with a personal access
 * token (`pat_…`) that IsaFlow binds to that company. Mirrors
 * lib/accounting/xero/connection.ts: the token is sealed (sealCredential,
 * WABA_ENC_KEY) and opened strictly (a value that is not sealed is refused,
 * never used as plaintext), and nothing here returns it.
 *
 * Connecting proves the token before anything is stored: list_companies names
 * the bound company (company_profile carries no id), and list_gl_accounts
 * proves read:reports. write:journals cannot be proven without writing; the
 * first push proves it. Only a TOTP-verified SUPER_ADMIN connects, verifies
 * or disconnects (app/api/integrations/isaflow, superAdminPolicyWrite); the
 * database refuses CONNECTED for anybody else (guardIsaFlowConnection).
 */
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isSealed, openSecret } from "@/lib/crypto/secret-box"
import { sealCredential } from "@/lib/integrations/tenant-credentials"
import { allowedIsaFlowOrigins, isaflowOrigin, IsaFlowUrlError } from "./base-url"
import { IsaFlowError, mcpTransport, type IsaFlowHttp, type IsaFlowTarget } from "./client"
import type { IsaFlowCompany } from "./contract"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
export type ConnectionDb = Pick<Tx, "isaFlowConnection">
export type ConnectionTx = Pick<Tx, "isaFlowConnection" | "auditLog">
export interface Actor { id: string; email: string }

const KEY_ENV = "WABA_ENC_KEY"

function open(value: string | null): string {
  if (!value || !isSealed(value)) throw new IsaFlowError("auth", "The stored IsaFlow token is missing; connect IsaFlow again")
  const key = process.env[KEY_ENV]
  if (!key) throw new IsaFlowError("config", `${KEY_ENV} is not set; the IsaFlow token cannot be opened`)
  return openSecret(value, key)
}

export interface ConnectInput { baseUrl: string; token: string }

/** The connect body, or why not. The token is checked for shape only; IsaFlow decides if it is valid. */
export function parseConnectInput(body: unknown): ConnectInput | string {
  const b = (body ?? {}) as Record<string, unknown>
  const token = typeof b.token === "string" ? b.token.trim() : ""
  if (!/^pat_[\x21-\x7e]{8,500}$/.test(token)) return "Give an IsaFlow personal access token (it starts with pat_)"
  if (typeof b.baseUrl !== "string" || !b.baseUrl.trim()) return "Give the IsaFlow address, e.g. https://app.isaflow.co.za"
  return { baseUrl: b.baseUrl.trim(), token }
}

export interface Probe { origin: string; company: IsaFlowCompany; accountCount: number }

/** Calls IsaFlow with the token: which company it is bound to, and that the chart can be read. */
export async function probeIsaFlow(target: IsaFlowTarget, http: IsaFlowHttp = {}): Promise<Probe> {
  let origin: string
  try {
    origin = isaflowOrigin(target.baseUrl, http.env ?? process.env)
  } catch (error) {
    if (error instanceof IsaFlowUrlError) throw new IsaFlowError("config", error.message)
    throw error
  }
  const isa = mcpTransport({ baseUrl: origin, token: target.token }, http)
  const company = await isa.company()
  const accounts = await isa.listGlAccounts()
  return { origin, company, accountCount: accounts.length }
}

async function audit(tx: Pick<Tx, "auditLog">, tenantId: string, actor: Actor, ip: string | null, action: string, newValue: Record<string, unknown>) {
  await logAuditStrict({ tenantId, userId: actor.id, userEmail: actor.email, action, entity: "IsaFlowConnection", entityId: tenantId, ipAddress: ip ?? undefined, newValue }, tx)
}

/**
 * Stores a proven connection. Only after superAdminPolicyWrite: the caller is
 * a SUPER_ADMIN of the tenant, re-checked on the locked row, whose session
 * verified a TOTP code (hence connectedWithTotp; the database checks both).
 */
export async function saveIsaFlowConnection(tx: ConnectionTx, args: { tenantId: string; actor: Actor; ip: string | null; probe: Probe; token: string; now?: Date }) {
  const now = args.now ?? new Date()
  let tokenSealed: string
  try {
    tokenSealed = sealCredential(args.token)
  } catch (error) {
    throw new IsaFlowError("config", error instanceof Error ? error.message : "The IsaFlow token cannot be sealed")
  }
  const previous = await tx.isaFlowConnection.findUnique({ where: { tenantId: args.tenantId }, select: { isaflowCompanyId: true } })
  const data = {
    status: "CONNECTED" as const, baseUrl: args.probe.origin, tokenSealed, tokenKind: "PAT" as const,
    isaflowCompanyId: args.probe.company.company_id, isaflowCompanyName: args.probe.company.name,
    connectedById: args.actor.id, connectedWithTotp: true, connectedAt: now, lastVerifiedAt: now, disconnectedAt: null,
  }
  await tx.isaFlowConnection.upsert({ where: { tenantId: args.tenantId }, create: { tenantId: args.tenantId, ...data }, update: data })
  await audit(tx, args.tenantId, args.actor, args.ip, AuditAction.ISAFLOW_CONNECTED, {
    baseUrl: args.probe.origin, isaflowCompanyId: args.probe.company.company_id, companyName: args.probe.company.name,
    accounts: args.probe.accountCount, previousCompanyId: previous?.isaflowCompanyId ?? null,
  })
}

/** Where and with what a CONNECTED tenant reaches IsaFlow. */
export async function isaflowTarget(db: ConnectionDb, tenantId: string): Promise<IsaFlowTarget & { companyId: string }> {
  const row = await db.isaFlowConnection.findUnique({ where: { tenantId } })
  if (!row || row.status !== "CONNECTED" || !row.isaflowCompanyId) throw new IsaFlowError("auth", "IsaFlow is not connected for this lender")
  return { baseUrl: row.baseUrl, token: open(row.tokenSealed), companyId: row.isaflowCompanyId }
}

/** Free text bound for an audit row, with anything shaped like a token or a sealed value cut out. */
export function redactTokens(text: string): string {
  return text.replace(/\b(?:pat|oat)_[\x21-\x7e]*/g, "[token]").replace(/enc:v1:[\x21-\x7e]*/g, "[sealed]")
}

/**
 * IsaFlow refused the token (or it is bound to another company now): it is
 * dropped and a SUPER_ADMIN must connect again. Audited, whichever path saw it.
 */
export async function markIsaFlowNeedsReconnect(tx: ConnectionTx, args: { tenantId: string; actor: Actor; ip?: string | null; reason: string }): Promise<boolean> {
  const moved = await tx.isaFlowConnection.updateMany({ where: { tenantId: args.tenantId, status: "CONNECTED" }, data: { status: "NEEDS_RECONNECT", tokenSealed: null } })
  if (moved.count !== 1) return false
  await audit(tx, args.tenantId, args.actor, args.ip ?? null, AuditAction.ISAFLOW_NEEDS_RECONNECT, { reason: redactTokens(args.reason).slice(0, 500) })
  return true
}

/**
 * Proves the stored token again; it must still be bound to the connected
 * company. Writes nothing: the caller applies an auth refusal
 * (markIsaFlowNeedsReconnect) inside its own guarded write.
 */
export async function verifyProbe(db: ConnectionDb, tenantId: string, http: IsaFlowHttp = {}): Promise<Probe> {
  const target = await isaflowTarget(db, tenantId)
  const probe = await probeIsaFlow(target, http)
  if (probe.company.company_id !== target.companyId) {
    throw new IsaFlowError("auth", "The token is now bound to a different IsaFlow company; connect IsaFlow again")
  }
  return probe
}

export async function recordIsaFlowVerified(tx: ConnectionTx, args: { tenantId: string; actor: Actor; ip: string | null; probe: Probe }): Promise<boolean> {
  const moved = await tx.isaFlowConnection.updateMany({
    where: { tenantId: args.tenantId, status: "CONNECTED", isaflowCompanyId: args.probe.company.company_id },
    data: { lastVerifiedAt: new Date(), isaflowCompanyName: args.probe.company.name },
  })
  if (moved.count !== 1) return false
  await audit(tx, args.tenantId, args.actor, args.ip, AuditAction.ISAFLOW_VERIFIED, { isaflowCompanyId: args.probe.company.company_id, accounts: args.probe.accountCount })
  return true
}

/** Local only: a PAT is revoked in IsaFlow, by the person who created it. */
export async function disconnectIsaFlow(tx: ConnectionTx, args: { tenantId: string; actor: Actor; ip: string | null }): Promise<void> {
  const row = await tx.isaFlowConnection.findUnique({ where: { tenantId: args.tenantId }, select: { status: true, isaflowCompanyId: true } })
  if (!row || row.status === "DISCONNECTED") return
  await tx.isaFlowConnection.update({ where: { tenantId: args.tenantId }, data: { status: "DISCONNECTED", tokenSealed: null, disconnectedAt: new Date() } })
  await audit(tx, args.tenantId, args.actor, args.ip, AuditAction.ISAFLOW_DISCONNECTED, { isaflowCompanyId: row.isaflowCompanyId })
}

/** What Settings may show: never a token. */
export async function isaflowStatus(db: ConnectionDb, tenantId: string, env: NodeJS.ProcessEnv = process.env) {
  const row = await db.isaFlowConnection.findUnique({
    where: { tenantId },
    select: { status: true, baseUrl: true, isaflowCompanyId: true, isaflowCompanyName: true, connectedAt: true, lastVerifiedAt: true },
  })
  const allowedOrigins = allowedIsaFlowOrigins(env)
  return {
    configured: allowedOrigins.length > 0,
    allowedOrigins,
    status: row?.status ?? "DISCONNECTED",
    baseUrl: row?.baseUrl ?? null,
    companyId: row?.status === "CONNECTED" ? row.isaflowCompanyId : null,
    companyName: row?.status === "CONNECTED" ? row.isaflowCompanyName : null,
    connectedAt: row?.status === "CONNECTED" ? row.connectedAt : null,
    lastVerifiedAt: row?.status === "CONNECTED" ? row.lastVerifiedAt : null,
  }
}
