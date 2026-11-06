/**
 * The simulated M-Pesa channel, for demos and tests. It moves no money, and
 * every transaction it reports is recorded `simulated`. Forbidden on a
 * deployed build unless "simulated-mpesa" is in SIMULATED_INTEGRATIONS
 * (lib/integrations/simulation-guard.ts). Not Daraja's wire format: a real
 * adapter (KE-6) translates Daraja's own bodies into the same callbacks.
 *
 * STK push outcomes are chosen by the phone's last four digits:
 *   0000 -> cancelled by the user       anything else -> paid in full
 * The push answers at once with its own signed callback, which the caller
 * delivers in-process through parseCallback (lib/mobile-money/stk-push.ts).
 *
 * Callbacks are HMAC-SHA256 signed with SIMULATED_MPESA_WEBHOOK_SECRET in the
 * `x-simulated-signature` header (hex), over `<timestamp>.<raw body>`, where
 * `x-simulated-timestamp` is unix seconds. Bodies:
 *   { type: "C2B", transId, billRef, amount: "1500.00", msisdn, transTime? }
 *   { type: "STK", checkoutRequestId, result: "PAID", transId, amount, msisdn, transTime? }
 *   { type: "STK", checkoutRequestId, result: "CANCELLED", reason }
 * A callback signed more than five minutes from now is refused, so a captured
 * one cannot be replayed later. The phone is cut to its last four digits here,
 * before anything else sees it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { assertSimulationAllowed, isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { amountToCents, msisdnLast4, type MobileMoneyCallback, type MobileMoneyProvider, type SignedCallback } from "../types"

export const CALLBACK_TOLERANCE_SECONDS = 300
const SECRET_ENV = "SIMULATED_MPESA_WEBHOOK_SECRET"
const ID = /^[A-Za-z0-9_-]{1,64}$/

export function signSimulatedCallback(rawBody: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
}

function secret(): string | null {
  return process.env[SECRET_ENV]?.trim() || null
}

function sign(body: Record<string, unknown>, key: string, now: Date): SignedCallback {
  const rawBody = JSON.stringify(body)
  const timestamp = Math.floor(now.getTime() / 1000)
  return {
    rawBody,
    headers: new Headers({
      "content-type": "application/json",
      "x-simulated-timestamp": String(timestamp),
      "x-simulated-signature": signSimulatedCallback(rawBody, key, timestamp),
    }),
  }
}

/** A receipt-number-shaped id: "SIM" and seven characters. */
function simulatedTransId(): string {
  return `SIM${randomBytes(4).toString("hex").slice(0, 7).toUpperCase()}`
}

/** A signed paybill payment, as the demo or a test sends one to the webhook. Needs the secret. */
export function simulatedC2BPayment(args: { billRef: string; amountCents: number; msisdn: string; transId?: string; now?: Date }): SignedCallback {
  const key = secret()
  if (!key) throw new Error(`${SECRET_ENV} is not set`)
  const now = args.now ?? new Date()
  return sign({
    type: "C2B", transId: args.transId ?? simulatedTransId(), billRef: args.billRef,
    amount: (args.amountCents / 100).toFixed(2), msisdn: args.msisdn, transTime: now.toISOString(),
  }, key, now)
}

function verified(rawBody: string, headers: Headers, now: Date): Record<string, unknown> | null {
  const key = secret()
  if (!key || !isSimulationPermitted("simulated-mpesa")) return null
  const timestamp = Number(headers.get("x-simulated-timestamp"))
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > CALLBACK_TOLERANCE_SECONDS) return null
  const given = headers.get("x-simulated-signature") ?? ""
  const expected = signSimulatedCallback(rawBody, key, timestamp)
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null
  try {
    const body: unknown = JSON.parse(rawBody)
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

function when(raw: unknown): Date | null {
  if (typeof raw !== "string") return null
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? null : at
}

function parse(body: Record<string, unknown>): MobileMoneyCallback | null {
  const { type, transId, checkoutRequestId, result } = body
  if (type === "C2B") {
    const amountCents = amountToCents(body.amount)
    if (typeof transId !== "string" || !ID.test(transId) || typeof body.billRef !== "string" || !amountCents) return null
    return {
      kind: "C2B", transId, billRef: body.billRef.trim().slice(0, 100), amountCents,
      msisdnLast4: msisdnLast4(body.msisdn), transactedAt: when(body.transTime),
    }
  }
  if (type !== "STK" || typeof checkoutRequestId !== "string" || !ID.test(checkoutRequestId)) return null
  if (result === "CANCELLED") {
    return { kind: "STK_CANCELLED", checkoutRequestId, reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : "Cancelled" }
  }
  const amountCents = amountToCents(body.amount)
  if (result !== "PAID" || typeof transId !== "string" || !ID.test(transId) || !amountCents) return null
  return { kind: "STK_PAID", checkoutRequestId, transId, amountCents, msisdnLast4: msisdnLast4(body.msisdn), transactedAt: when(body.transTime) }
}

export const simulatedMpesa: MobileMoneyProvider = {
  id: "simulated",
  displayName: "Simulated M-Pesa (no money moves)",
  simulation: () => "simulated-mpesa",

  async requestStkPush(request) {
    assertSimulationAllowed("simulated-mpesa", true)
    const key = secret()
    if (!key) return { kind: "rejected", reason: `${SECRET_ENV} is not set: the simulated push could not sign its result` }
    const checkoutRequestId = `ws_CO_SIM_${randomBytes(8).toString("hex")}`
    const now = new Date()
    const body = request.msisdn.endsWith("0000")
      ? { type: "STK", checkoutRequestId, result: "CANCELLED", reason: "Request cancelled by user" }
      : {
          type: "STK", checkoutRequestId, result: "PAID", transId: simulatedTransId(),
          amount: (request.amountCents / 100).toFixed(2), msisdn: msisdnLast4(request.msisdn), transTime: now.toISOString(),
        }
    return { kind: "accepted", checkoutRequestId, simulated: true, callback: sign(body, key, now) }
  },

  parseCallback({ rawBody, headers, now }) {
    const body = verified(rawBody, headers, now ?? new Date())
    return body ? parse(body) : null
  },
}
