/**
 * A tenant's Xero connection: the PKCE handshake, organisation choice,
 * token refresh and disconnect. Tokens and the PKCE verifier are sealed with
 * secret-box under WABA_ENC_KEY (one box, one key, as lib/bureau/credentials.ts).
 * W0's lib/integrations/tenant-credentials.ts was not on main when this was
 * written; these sealed columns are a candidate to move there.
 */
import { randomBytes } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { isSealed, openSecret, sealSecret } from "@/lib/crypto/secret-box"
import {
  authorizeUrl, createPkcePair, exchangeCode, listOrganisations, refreshTokens, removeConnection, revokeRefreshToken,
  xeroAppConfig, XeroError, type XeroAppConfig, type XeroHttp, type XeroOrganisation, type XeroTokens,
} from "./client"

export type XeroDb = Pick<typeof prisma, "xeroConnection" | "$transaction">

const KEY_ENV = "WABA_ENC_KEY"
/** A handshake older than this is refused at the callback. */
export const AUTH_STATE_TTL_MS = 10 * 60 * 1000
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60 * 1000

function key(): string {
  const value = process.env[KEY_ENV]
  if (!value) throw new XeroError("config", `${KEY_ENV} is not set; Xero tokens cannot be sealed or opened`)
  return value
}
const seal = (value: string) => sealSecret(value, key())
function open(value: string | null): string {
  if (!value || !isSealed(value)) throw new XeroError("auth", "Stored Xero credentials are missing; reconnect Xero")
  return openSecret(value, key())
}

export function requireXeroConfig(): XeroAppConfig {
  const config = xeroAppConfig()
  if (!config) throw new XeroError("config", "Xero is not set up on this deployment (XERO_CLIENT_ID, XERO_REDIRECT_URI)")
  return config
}

export async function startXeroConnect(db: XeroDb, args: { tenantId: string; userId: string }): Promise<string> {
  const config = requireXeroConfig()
  const { verifier, challenge } = createPkcePair()
  const state = randomBytes(24).toString("base64url")
  const pending = { authState: state, authVerifierSealed: seal(verifier), authStartedAt: new Date(), authStartedById: args.userId }
  await db.xeroConnection.upsert({
    where: { tenantId: args.tenantId },
    create: { tenantId: args.tenantId, status: "PENDING_AUTH", ...pending },
    // A reconnect keeps the current connection usable until the new one lands.
    update: pending,
  })
  return authorizeUrl(config, state, challenge)
}

export type ConnectResult = { status: "CONNECTED"; organisation: XeroOrganisation } | { status: "SELECT_ORGANISATION"; organisations: XeroOrganisation[] }

function tokenColumns(tokens: XeroTokens) {
  return { accessTokenSealed: seal(tokens.accessToken), refreshTokenSealed: seal(tokens.refreshToken), accessTokenExpiresAt: tokens.expiresAt }
}

const clearedHandshake = { authState: null, authVerifierSealed: null, authStartedAt: null, authStartedById: null }

/** The callback: the state must be this tenant's, started by this user, and fresh. */
export async function completeXeroConnect(db: XeroDb, args: {
  tenantId: string
  userId: string
  state: string
  code: string
  now?: Date
}, http: XeroHttp = {}): Promise<ConnectResult> {
  const config = requireXeroConfig()
  const now = args.now ?? new Date()
  const row = await db.xeroConnection.findFirst({ where: { tenantId: args.tenantId, authState: args.state } })
  if (!row || row.authStartedById !== args.userId || !row.authStartedAt || now.getTime() - row.authStartedAt.getTime() > AUTH_STATE_TTL_MS) {
    throw new XeroError("auth", "This Xero sign-in is not valid here or has expired; start again from Settings")
  }
  const verifier = open(row.authVerifierSealed)
  // Single use: the state is cleared before the code is spent.
  const claimed = await db.xeroConnection.updateMany({ where: { id: row.id, authState: args.state }, data: clearedHandshake })
  if (claimed.count !== 1) throw new XeroError("auth", "This Xero sign-in was already used")
  const tokens = await exchangeCode(config, { code: args.code, verifier }, http, now)
  const organisations = await listOrganisations(tokens.accessToken, http)
  if (organisations.length === 0) throw new XeroError("definite", "The Xero user has no organisation to connect")
  const base = { ...tokenColumns(tokens), connectedById: args.userId, connectedAt: now, disconnectedAt: null }
  if (organisations.length === 1) {
    const [org] = organisations
    await db.xeroConnection.update({
      where: { id: row.id },
      data: { ...base, status: "CONNECTED", organisations: Prisma.JsonNull, xeroTenantId: org.tenantId, xeroTenantName: org.tenantName, xeroConnectionId: org.connectionId },
    })
    return { status: "CONNECTED", organisation: org }
  }
  await db.xeroConnection.update({
    where: { id: row.id },
    data: { ...base, status: "SELECT_ORGANISATION", organisations: organisations as unknown as Prisma.InputJsonValue, xeroTenantId: null, xeroTenantName: null, xeroConnectionId: null },
  })
  return { status: "SELECT_ORGANISATION", organisations }
}

export async function selectXeroOrganisation(db: XeroDb, args: { tenantId: string; xeroTenantId: string }): Promise<XeroOrganisation> {
  const row = await db.xeroConnection.findUnique({ where: { tenantId: args.tenantId } })
  const offered = (row?.organisations ?? []) as unknown as XeroOrganisation[]
  const org = Array.isArray(offered) ? offered.find((o) => o.tenantId === args.xeroTenantId) : undefined
  if (!row || row.status !== "SELECT_ORGANISATION" || !org) throw new XeroError("definite", "That organisation was not offered by this Xero sign-in")
  await db.xeroConnection.update({
    where: { id: row.id },
    data: { status: "CONNECTED", xeroTenantId: org.tenantId, xeroTenantName: org.tenantName, xeroConnectionId: org.connectionId, organisations: Prisma.JsonNull },
  })
  return org
}

/** Local disconnect always succeeds; removing the connection at Xero is best effort. */
export async function disconnectXero(db: XeroDb, args: { tenantId: string }, http: XeroHttp = {}): Promise<{ remoteCleanup: boolean }> {
  const row = await db.xeroConnection.findUnique({ where: { tenantId: args.tenantId } })
  if (!row) return { remoteCleanup: true }
  let remoteCleanup = false
  const config = xeroAppConfig()
  if (config && row.accessTokenSealed && row.refreshTokenSealed) {
    try {
      const removed = row.xeroConnectionId ? await removeConnection(open(row.accessTokenSealed), row.xeroConnectionId, http) : true
      const revoked = await revokeRefreshToken(config, open(row.refreshTokenSealed), http)
      remoteCleanup = removed && revoked
    } catch (error) {
      console.error("Xero remote disconnect failed:", error instanceof Error ? error.name : "unknown")
    }
  }
  await db.xeroConnection.update({
    where: { id: row.id },
    data: {
      ...clearedHandshake, status: "DISCONNECTED", accessTokenSealed: null, refreshTokenSealed: null, accessTokenExpiresAt: null,
      organisations: Prisma.JsonNull, xeroTenantId: null, xeroTenantName: null, xeroConnectionId: null, disconnectedAt: new Date(),
    },
  })
  return { remoteCleanup }
}

/**
 * A usable access token for a CONNECTED tenant, refreshed under a row lock so
 * two pushes never spend the same rotating refresh token.
 */
export async function xeroAccessToken(db: XeroDb, tenantId: string, http: XeroHttp = {}, now = new Date()): Promise<{ accessToken: string; xeroTenantId: string }> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "XeroConnection" WHERE "tenantId" = ${tenantId} FOR UPDATE`)
    const row = await tx.xeroConnection.findUnique({ where: { tenantId } })
    if (!row || row.status !== "CONNECTED" || !row.xeroTenantId) throw new XeroError("auth", "Xero is not connected for this lender")
    if (row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime()) {
      return { accessToken: open(row.accessTokenSealed), xeroTenantId: row.xeroTenantId }
    }
    try {
      const tokens = await refreshTokens(requireXeroConfig(), open(row.refreshTokenSealed), http, now)
      await tx.xeroConnection.update({ where: { id: row.id }, data: tokenColumns(tokens) })
      return { accessToken: tokens.accessToken, xeroTenantId: row.xeroTenantId }
    } catch (error) {
      // Refused (revoked, expired after 60 idle days, rotated elsewhere): the
      // connection needs an admin to connect again. The status change commits;
      // the caller still gets the error.
      if (error instanceof XeroError && error.kind === "auth") {
        await tx.xeroConnection.update({ where: { id: row.id }, data: { status: "NEEDS_RECONNECT", accessTokenSealed: null, accessTokenExpiresAt: null } })
        return error
      }
      throw error
    }
  }, { timeout: 30_000 }).then((out) => {
    if (out instanceof XeroError) throw out
    return out
  })
}

/** What Settings may show: never a token. */
export async function xeroStatus(db: XeroDb, tenantId: string) {
  const row = await db.xeroConnection.findUnique({ where: { tenantId } })
  const organisations = row?.status === "SELECT_ORGANISATION" && Array.isArray(row.organisations)
    ? (row.organisations as unknown as XeroOrganisation[]).map((o) => ({ tenantId: o.tenantId, tenantName: o.tenantName }))
    : []
  return {
    configured: xeroAppConfig() !== null,
    status: row?.status ?? "DISCONNECTED",
    organisationName: row?.status === "CONNECTED" ? row.xeroTenantName : null,
    organisations,
    connectedAt: row?.status === "CONNECTED" ? row.connectedAt : null,
  }
}
