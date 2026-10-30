/**
 * A lender's audit policy (AuditPolicy): retention and SIEM forwarding.
 * The only reader and writer of the sealed columns; a response shows whether a
 * secret is set, never any of it, and a SIEM URL as its origin only (its path or query
 * may carry a key). Secrets are sealed with the same key as the provider credentials
 * (lib/integrations/tenant-credentials.ts). The policy changes only through the
 * database function audit_policy_save, which also writes the audit row.
 *
 * retentionMonths / hotMonths are recorded policy only: nothing deletes or archives audit
 * rows yet (they are append-only), so they state what the lender must keep, not what the
 * system enforces. Archiving up to a checkpoint is a follow-up.
 */
import { isIP } from "node:net"
import type { AuditPolicy } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { openCredential, sealCredential } from "@/lib/integrations/tenant-credentials"
import { logger } from "@/lib/observability/logger"
import { savePolicy } from "@/lib/audit/store"
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
  /** The SIEM URL's origin; the path and query are never returned. */
  siemOrigin: string | null
  siemUrlHasPathOrQuery: boolean
  siemTokenSet: boolean
  siemCaCertPem: string | null
  siemClientCert: string | null
  siemClientKeySet: boolean
}

export const DEFAULT_VIEW: AuditPolicyView = {
  retentionMonths: MIN_RETENTION_MONTHS, hotMonths: MIN_HOT_MONTHS, siemEnabled: false, siemTransport: "HTTPS_JSON",
  siemHost: null, siemPort: null, siemOrigin: null, siemUrlHasPathOrQuery: false, siemTokenSet: false, siemCaCertPem: null, siemClientCert: null, siemClientKeySet: false,
}

function urlView(url: string | null): { siemOrigin: string | null; siemUrlHasPathOrQuery: boolean } {
  if (!url) return { siemOrigin: null, siemUrlHasPathOrQuery: false }
  try {
    const n = normaliseSiemUrl(url)
    return { siemOrigin: n.origin, siemUrlHasPathOrQuery: n.hasPathOrQuery }
  } catch {
    return { siemOrigin: null, siemUrlHasPathOrQuery: false }
  }
}

export function policyView(row: AuditPolicy | null): AuditPolicyView {
  if (!row) return DEFAULT_VIEW
  return {
    retentionMonths: row.retentionMonths, hotMonths: row.hotMonths, siemEnabled: row.siemEnabled, siemTransport: row.siemTransport,
    siemHost: row.siemHost, siemPort: row.siemPort, ...urlView(row.siemUrl), siemTokenSet: row.siemSealedToken !== null,
    siemCaCertPem: row.siemCaCertPem, siemClientCert: row.siemClientCert, siemClientKeySet: row.siemSealedKey !== null,
  }
}

/** The whole policy as audit_policy_save takes it (secrets sealed; null clears a column). */
export interface PolicyWrite {
  retentionMonths: number
  hotMonths: number
  siemEnabled: boolean
  siemTransport: "SYSLOG_TLS" | "HTTPS_JSON"
  siemHost: string | null
  siemPort: number | null
  /** Normalised (`new URL(url).href`): https, no credentials, no backslash, whitespace or control character. */
  siemUrl: string | null
  /** The URL's origin and whether it has a path or query, as WHATWG parsing says; the database checks them against the URL. */
  siemOrigin: string | null
  siemUrlHasPathOrQuery: boolean
  siemSealedToken: string | null
  siemCaCertPem: string | null
  siemClientCert: string | null
  siemSealedKey: string | null
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

const URL_FORBIDDEN = /[\\\s\u0000-\u001f\u007f]/

/**
 * A SIEM URL as the application and the database will both read it. A browser, a SIEM and a regex disagree about
 * a backslash (WHATWG treats it as a slash), tabs and newlines (stripped), so none of them is accepted; what is
 * stored is `new URL(url).href`, https only, with no credentials. The origin and whether a path or query is
 * set come from the same parse, and go to the database with the URL.
 */
export function normaliseSiemUrl(url: string): { href: string; origin: string; hasPathOrQuery: boolean } {
  if (URL_FORBIDDEN.test(url)) throw new AuditPolicyError("siemUrl must not contain a backslash, whitespace or a control character.")
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new AuditPolicyError("siemUrl is not a valid URL.") }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new AuditPolicyError("siemUrl must be https with no credentials in it.")
  const hasPathOrQuery = (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search !== "" || parsed.hash !== ""
  return { href: parsed.href, origin: parsed.origin, hasPathOrQuery }
}

/** Validates the input against the current row and returns the columns to write. */
export async function buildPolicyWrite(
  input: AuditPolicyInput,
  current: AuditPolicy | null,
  resolve?: Resolver,
): Promise<PolicyWrite> {
  const cur = { ...policyView(current), siemUrl: current?.siemUrl ?? null }
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
  const normalised = url === null ? null : normaliseSiemUrl(url)
  if (siemEnabled) {
    if (transport === "SYSLOG_TLS" && (!host || !port)) throw new AuditPolicyError("SYSLOG_TLS needs siemHost and siemPort.")
    if (transport === "HTTPS_JSON" && !normalised) throw new AuditPolicyError("HTTPS_JSON needs siemUrl.")
    const dialled = transport === "SYSLOG_TLS" ? host! : new URL(normalised!.href).hostname
    await resolveSiemHost(dialled, resolve).catch((error: unknown) => {
      // The detail names an address; the admin gets the reason class only.
      logger.warn("[audit-policy] SIEM destination refused", { host: dialled, reason: error instanceof Error ? error.message : String(error) })
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
    retentionMonths, hotMonths, siemEnabled, siemTransport: transport, siemHost: host, siemPort: port,
    siemUrl: normalised?.href ?? null, siemOrigin: normalised?.origin ?? null, siemUrlHasPathOrQuery: normalised?.hasPathOrQuery ?? false,
    siemSealedToken: sealedToken, siemCaCertPem: ca, siemClientCert: clientCert, siemSealedKey: sealedKey,
  }
}

/** The destination fields of a policy, secrets still sealed: what a stamped outbox entry (and the AuditPolicyRevision trigger) carries. */
export type TargetSnapshot = Pick<AuditPolicy, "siemTransport" | "siemHost" | "siemPort" | "siemUrl" | "siemSealedToken" | "siemCaCertPem" | "siemClientCert" | "siemSealedKey">

/**
 * Saves the policy through audit_policy_save, the only way it changes. In one transaction the
 * database writes the policy, records the revision (trigger audit_policy_revision), stamps
 * everything still queued with the OLD destination, writes the AUDIT_POLICY_UPDATED audit row
 * itself and queues that row for the old destination (so whoever redirects or disables the feed
 * leaves a trace where the bank's SOC looks, and the backlog is never lost); a lender that starts
 * forwarding, or moves it, first sends an anchor event (the chain position at that moment). The
 * current policy is read inside the transaction, under a per-lender lock, so two saves do not
 * merge on a stale read.
 */
export async function saveAuditPolicy(
  tenantId: string,
  actor: { id: string; email?: string | null },
  input: AuditPolicyInput,
  opts: { ipAddress?: string; resolve?: Resolver } = {},
): Promise<AuditPolicyView> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`audit-policy:${tenantId}`}, 0))`
    const current = await tx.auditPolicy.findUnique({ where: { tenantId } })
    const data = await buildPolicyWrite(input, current, opts.resolve)
    await savePolicy(tx, tenantId, { ...data }, actor, opts.ipAddress)
    return policyView(await tx.auditPolicy.findUniqueOrThrow({ where: { tenantId } }))
  }, { timeout: 20_000 })
}

/** The delivery target for a policy or a snapshot of one, secrets opened. Throws if a sealed value cannot be opened. */
export function siemTarget(row: TargetSnapshot): SiemTarget {
  return {
    transport: row.siemTransport, host: row.siemHost, port: row.siemPort, url: row.siemUrl,
    token: openCredential(row.siemSealedToken), caCertPem: row.siemCaCertPem,
    clientCertPem: row.siemClientCert, clientKeyPem: openCredential(row.siemSealedKey),
  }
}
