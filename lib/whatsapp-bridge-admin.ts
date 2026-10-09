// Typed client for the unofficial bridge's authenticated admin API
// (/numbers and friends). Mirrors lib/whatsapp.ts's env-driven URL
// resolution but targets the admin surface, not /send-message.

export interface WaBridgeSlot {
  slotId: string
  number: string | null
  status: "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT" | "RETIRED" | "PAUSED"
  priority: number
  connectedAt: string | null
  disconnectedAt: string | null
  lastDisconnectReason: string | null
}

export interface WaBridgeAddNumberResult {
  slotId: string
  pairingCode: string
  expiresAt: string
}

// Unlike lib/whatsapp.ts's send path, this admin client throws rather than
// defaulting when WA_SENDER_URL is unset. The two files used to fall back to
// DIFFERENT hosts, so wherever the var wasn't set (staging is the likely
// case) the cron polled a different endpoint than sends actually use --
// silently inverting the alert's meaning (CRITICAL on a healthy channel, or
// silence on a dead one). Guessing a default here is worse than refusing to
// start, the same reasoning getAdminSecret() already applies to the secret.
function getBridgeUrl(): string {
  const url = process.env.WA_SENDER_URL
  if (!url) throw new Error("WA_SENDER_URL is not configured")
  return url
}

function getAdminSecret(): string {
  const secret = process.env.WA_BRIDGE_ADMIN_SECRET
  if (!secret) throw new Error("WA_BRIDGE_ADMIN_SECRET is not configured")
  return secret
}

const DEFAULT_TIMEOUT_MS = 15_000

async function bridgeFetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {}
  return fetch(`${getBridgeUrl()}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", "x-bridge-admin-secret": getAdminSecret(), ...rest.headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** Error carrying the bridge's HTTP status, so callers can tell a
 *  deterministic refusal (409 — the guard ran, nothing was attempted) from a
 *  failure of unknown outcome (5xx / timeout). The audit trail records those
 *  differently, and marking a certain rejection "UNCERTAIN" would put false
 *  doubt into a regulated lender's evidence. */
export class WaBridgeError extends Error {
  readonly status: number
  /** Bridge-side reason code. NUMBER_NOT_REGISTERED is confirmable by the
   *  operator; NUMBER_CONFLICT never is. */
  readonly code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "WaBridgeError"
    this.status = status
    this.code = code
  }
}

async function throwOnError(res: Response, fallback: string): Promise<void> {
  if (res.ok) return
  const body = await res.json().catch(() => ({}) as { error?: string; code?: string })
  throw new WaBridgeError(body?.error ?? `${fallback}: ${res.status}`, res.status, body?.code)
}

// `timeoutMs` lets callers on a stricter time budget (the Comms Settings
// page load, which must degrade to its "unreachable" state quickly rather
// than stall the whole page) shorten the default 15s bound. Interactive
// callers (the admin tab's refresh(), the /numbers API route) omit it and
// keep the default.
export async function listWaBridgeNumbers(opts?: { timeoutMs?: number }): Promise<WaBridgeSlot[]> {
  const res = await bridgeFetch("/numbers", { timeoutMs: opts?.timeoutMs })
  await throwOnError(res, "bridge /numbers failed")
  const body = (await res.json()) as { numbers: WaBridgeSlot[] }
  return body.numbers
}

// The bridge's own ADD_SLOT_PAIRING_TIMEOUT_MS (services/whatsapp-bridge/src/
// index.js) is 30s. This bound must sit comfortably above that: if it fired
// first, the app would report a 502 "add failed" while the bridge was still
// pairing, and the abort doesn't cancel bridge-side work -- so a pairing
// that then succeeded would leave a live slot nobody saw the pairing code
// for, and a retry could create a second one.
const ADD_NUMBER_TIMEOUT_MS = 40_000

export async function addWaBridgeNumber(number: string, confirmNew = false): Promise<WaBridgeAddNumberResult> {
  const res = await bridgeFetch("/numbers", { method: "POST", body: JSON.stringify({ number, confirmNew }), timeoutMs: ADD_NUMBER_TIMEOUT_MS })
  await throwOnError(res, "bridge add number failed")
  return (await res.json()) as WaBridgeAddNumberResult
}

export async function setWaBridgeNumberPriority(slotId: string, priority: number): Promise<void> {
  const res = await bridgeFetch(`/numbers/${encodeURIComponent(slotId)}`, { method: "PATCH", body: JSON.stringify({ priority }) })
  await throwOnError(res, "bridge set priority failed")
}

export async function promoteWaBridgeNumber(slotId: string): Promise<void> {
  const res = await bridgeFetch(`/numbers/${encodeURIComponent(slotId)}/promote`, { method: "POST" })
  await throwOnError(res, "bridge promote failed")
}

/** Re-pairs a slot whose session WhatsApp revoked, in one step. Uses the same
 *  generous bound as adding a number — it IS an add, preceded by a retire. */
export async function relinkWaBridgeNumber(slotId: string): Promise<WaBridgeAddNumberResult> {
  const res = await bridgeFetch(`/numbers/${encodeURIComponent(slotId)}/relink`, {
    method: "POST",
    timeoutMs: ADD_NUMBER_TIMEOUT_MS,
  })
  await throwOnError(res, "bridge relink failed")
  return (await res.json()) as WaBridgeAddNumberResult
}

/** Parks a number without revoking its WhatsApp session, so resuming needs no
 *  pairing code and no phone. Only retire logs the number out. */
export async function setWaBridgeNumberPaused(slotId: string, paused: boolean): Promise<void> {
  const action = paused ? "pause" : "resume"
  const res = await bridgeFetch(`/numbers/${encodeURIComponent(slotId)}/${action}`, { method: "POST" })
  await throwOnError(res, `bridge ${action} failed`)
}

export async function retireWaBridgeNumber(slotId: string): Promise<{ authDirRemoved: boolean }> {
  const res = await bridgeFetch(`/numbers/${encodeURIComponent(slotId)}`, { method: "DELETE" })
  await throwOnError(res, "bridge retire failed")
  // A bridge older than the flag reports nothing; treat that as removed rather
  // than raising a false cleanup warning on every retire.
  const body = (await res.json().catch(() => null)) as { authDirRemoved?: boolean } | null
  return { authDirRemoved: body?.authDirRemoved !== false }
}
