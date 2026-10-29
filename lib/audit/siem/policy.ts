/**
 * A lender's audit policy (AuditPolicy): retention and SIEM forwarding.
 * The only reader and writer of the sealed columns; a response shows whether a
 * secret is set, never any of it. Secrets are sealed with the same key as the
 * provider credentials (lib/integrations/tenant-credentials.ts).
 */
import { randomUUID } from "node:crypto"
import { isIP } from "node:net"
import type { AuditPolicy, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { logAuditStrict, AuditAction } from "@/lib/audit"
import { openCredential, sealCredential } from "@/lib/integrations/tenant-credentials"
import { resolveSiemHost } from "./destination"
import type { SiemTarget } from "./transport"
import type { Resolver } from "@/lib/lender-api/webhooks/ssrf"

export const MIN_RETENTION_MONTHS = 12
export const MIN_HOT_MONTHS = 3

export interface AuditPolicyInput {
  retentionMonths?: unknown
  hotMonths?: unknown
  siemEnabled?: unknown
  siemTransport?: unknown
  siemHost?: unknown
  siemPort?: unknown
  siemUrl?: unknown
  /** A new bearer token; null clears it; absent keeps the stored one. */
  siemToken?: unknown
  siemCaCertPem?: unknown
  siemClientCert?: unknown
  siemClientKey?: unknown
}

export interface AuditPolicyView {
  retentionMonths: number
  hotMonths: number
  siemEnabled: boolean
  siemTransport: "SYSLOG_TLS" | "HTTPS_JSON"
  siemHost: string | null
  siemPort: number | null
  siemUrl: string | null
  siemTokenSet: boolean
  siemCaCertPem: string | null
  siemClientCert: string | null
  siemClientKeySet: boolean
}

export const DEFAULT_VIEW: AuditPolicyView = {
  retentionMonths: MIN_RETENTION_MONTHS, hotMonths: MIN_HOT_MONTHS, siemEnabled: false, siemTransport: "HTTPS_JSON",
  siemHost: null, siemPort: null, siemUrl: null, siemTokenSet: false, siemCaCertPem: null, siemClientCert: null, siemClientKeySet: false,
}

export function policyView(row: AuditPolicy | null): AuditPolicyView {
  if (!row) return DEFAULT_VIEW
  return {
    retentionMonths: row.retentionMonths, hotMonths: row.hotMonths, siemEnabled: row.siemEnabled, siemTransport: row.siemTransport,
    siemHost: row.siemHost, siemPort: row.siemPort, siemUrl: row.siemUrl, siemTokenSet: row.siemSealedToken !== null,
    siemCaCertPem: row.siemCaCertPem, siemClientCert: row.siemClientCert, siemClientKeySet: row.siemSealedKey !== null,
  }
}

export class AuditPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuditPolicyError"
  }
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const PEM = /^-----BEGIN [A-Z ]+-----[\s\S]+-----END [A-Z ]+-----\s*$/
const MAX_PEM = 16_384

function int(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AuditPolicyError(`${name} must be a whole number from ${min} to ${max}.`)
  }
  return value
}

function text(value: unknown, name: string, max: number): string | null {
  if (value === null || value === "") return null
  if (typeof value !== "string" || value.length > max) throw new AuditPolicyError(`${name} must be text of at most ${max} characters.`)
  return value.trim()
}

function pem(value: unknown, name: string): string | null {
  const v = text(value, name, MAX_PEM)
  if (v !== null && !PEM.test(v)) throw new AuditPolicyError(`${name} must be a PEM block.`)
  return v
}

/** Validates the input against the current row and returns the columns to write. */
export async function buildPolicyWrite(
  input: AuditPolicyInput,
  current: AuditPolicy | null,
  resolve?: Resolver,
): Promise<Prisma.AuditPolicyUncheckedUpdateInput> {
  const cur = policyView(current)
  const retentionMonths = input.retentionMonths === undefined ? cur.retentionMonths : int(input.retentionMonths, "retentionMonths", MIN_RETENTION_MONTHS, 600)
  const hotMonths = input.hotMonths === undefined ? cur.hotMonths : int(input.hotMonths, "hotMonths", MIN_HOT_MONTHS, 600)
  if (hotMonths > retentionMonths) throw new AuditPolicyError("hotMonths cannot exceed retentionMonths.")

  const siemEnabled = input.siemEnabled === undefined ? cur.siemEnabled : input.siemEnabled
  if (typeof siemEnabled !== "boolean") throw new AuditPolicyError("siemEnabled must be true or false.")
  const transport = input.siemTransport === undefined ? cur.siemTransport : input.siemTransport
  if (transport !== "SYSLOG_TLS" && transport !== "HTTPS_JSON") throw new AuditPolicyError("siemTransport must be SYSLOG_TLS or HTTPS_JSON.")

  const host = input.siemHost === undefined ? cur.siemHost : text(input.siemHost, "siemHost", 253)
  const port = input.siemPort === undefined ? cur.siemPort : input.siemPort === null ? null : int(input.siemPort, "siemPort", 1, 65535)
  const url = input.siemUrl === undefined ? cur.siemUrl : text(input.siemUrl, "siemUrl", 2048)
  const ca = input.siemCaCertPem === undefined ? cur.siemCaCertPem : pem(input.siemCaCertPem, "siemCaCertPem")
  const clientCert = input.siemClientCert === undefined ? cur.siemClientCert : pem(input.siemClientCert, "siemClientCert")

  if (host !== null && !HOSTNAME.test(host) && isIP(host) === 0) throw new AuditPolicyError("siemHost is not a valid host name or address.")
  if (url !== null) {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new AuditPolicyError("siemUrl is not a valid URL.") }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new AuditPolicyError("siemUrl must be https with no credentials in it.")
  }
  if (siemEnabled) {
    if (transport === "SYSLOG_TLS" && (!host || !port)) throw new AuditPolicyError("SYSLOG_TLS needs siemHost and siemPort.")
    if (transport === "HTTPS_JSON" && !url) throw new AuditPolicyError("HTTPS_JSON needs siemUrl.")
    const dialled = transport === "SYSLOG_TLS" ? host! : new URL(url!).hostname
    await resolveSiemHost(dialled, resolve).catch((error: unknown) => {
      // The detail names an address; the admin gets the reason class only.
      console.warn("[audit-policy] SIEM destination refused", { host: dialled, reason: error instanceof Error ? error.message : String(error) })
      throw new AuditPolicyError("The SIEM host does not resolve to an address this deployment may dial.")
    })
  }

  const secret = (value: unknown, name: string, stored: string | null): string | null => {
    if (value === undefined) return stored
    if (value === null || value === "") return null
    if (typeof value !== "string" || value.length > MAX_PEM) throw new AuditPolicyError(`${name} must be text.`)
    return sealCredential(value)
  }
  const sealedToken = secret(input.siemToken, "siemToken", current?.siemSealedToken ?? null)
  const sealedKey = secret(input.siemClientKey, "siemClientKey", current?.siemSealedKey ?? null)
  if ((clientCert === null) !== (sealedKey === null)) throw new AuditPolicyError("siemClientCert and siemClientKey go together.")

  return {
    retentionMonths, hotMonths, siemEnabled, siemTransport: transport, siemHost: host, siemPort: port, siemUrl: url,
    siemSealedToken: sealedToken, siemCaCertPem: ca, siemClientCert: clientCert, siemSealedKey: sealedKey, updatedAt: new Date(),
  }
}

/** The destination fields of a policy, secrets still sealed: what a policy-change row is sent to after the policy moves on. */
export type TargetSnapshot = Pick<AuditPolicy, "siemTransport" | "siemHost" | "siemPort" | "siemUrl" | "siemSealedToken" | "siemCaCertPem" | "siemClientCert" | "siemSealedKey">

function snapshotOf(row: AuditPolicy): TargetSnapshot {
  return {
    siemTransport: row.siemTransport, siemHost: row.siemHost, siemPort: row.siemPort, siemUrl: row.siemUrl,
    siemSealedToken: row.siemSealedToken, siemCaCertPem: row.siemCaCertPem, siemClientCert: row.siemClientCert, siemSealedKey: row.siemSealedKey,
  }
}

const destination = (p: TargetSnapshot | null) =>
  p ? `${p.siemTransport}|${p.siemHost ?? ""}|${p.siemPort ?? ""}|${p.siemUrl ?? ""}` : ""

/** What the audit row of a policy change records: no secrets, no certificates, and a URL as origin only (its path or query may carry a key). */
function auditView(row: AuditPolicy | null) {
  const v = policyView(row)
  return {
    retentionMonths: v.retentionMonths, hotMonths: v.hotMonths, siemEnabled: v.siemEnabled, siemTransport: v.siemTransport,
    siemHost: v.siemHost, siemPort: v.siemPort, siemOrigin: v.siemUrl ? new URL(v.siemUrl).origin : null,
    siemTokenSet: v.siemTokenSet, siemClientKeySet: v.siemClientKeySet,
  }
}

/**
 * Writes the policy and its audit row in one transaction. Changing or switching off
 * forwarding is itself an event: the audit row is queued for the OLD destination (so
 * whoever redirects or disables the feed leaves a trace where the bank's SOC looks),
 * and a lender that starts forwarding, or moves it, first sends an anchor event
 * (the chain head at that moment).
 */
export async function saveAuditPolicy(
  tenantId: string,
  actor: { id: string; email?: string | null },
  input: AuditPolicyInput,
  opts: { ipAddress?: string; resolve?: Resolver } = {},
): Promise<AuditPolicyView> {
  const current = await prisma.auditPolicy.findUnique({ where: { tenantId } })
  const data = await buildPolicyWrite(input, current, opts.resolve)
  return prisma.$transaction(async (tx) => {
    const row = await tx.auditPolicy.upsert({
      where: { tenantId },
      create: { ...(data as Prisma.AuditPolicyUncheckedCreateInput), tenantId },
      update: data,
    })
    const auditId = `aud_${randomUUID().replaceAll("-", "")}`
    await logAuditStrict({
      id: auditId, tenantId, userId: actor.id, userEmail: actor.email ?? undefined, action: AuditAction.AUDIT_POLICY_UPDATED, entity: "AuditPolicy",
      entityId: row.id, oldValue: auditView(current), newValue: auditView(row), ipAddress: opts.ipAddress,
    }, tx)

    const moved = destination(current && current.siemEnabled ? snapshotOf(current) : null) !== destination(row.siemEnabled ? snapshotOf(row) : null)
    if (current?.siemEnabled && moved) {
      await tx.auditSiemOutbox.create({
        data: { tenantId, kind: "EVENT", auditLogId: auditId, targetSnapshot: snapshotOf(current) as unknown as Prisma.InputJsonValue },
      })
    }
    if (row.siemEnabled && moved) await tx.auditSiemOutbox.create({ data: { tenantId, kind: "ANCHOR" } })
    return policyView(row)
  })
}

/** The delivery target for a policy or a snapshot of one, secrets opened. Throws if a sealed value cannot be opened. */
export function siemTarget(row: TargetSnapshot): SiemTarget {
  return {
    transport: row.siemTransport, host: row.siemHost, port: row.siemPort, url: row.siemUrl,
    token: openCredential(row.siemSealedToken), caCertPem: row.siemCaCertPem,
    clientCertPem: row.siemClientCert, clientKeyPem: openCredential(row.siemSealedKey),
  }
}
