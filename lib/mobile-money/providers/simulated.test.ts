import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { signSimulatedCallback, simulatedC2BPayment, simulatedMpesa, CALLBACK_TOLERANCE_SECONDS } from "./simulated"
import { amountToCents, MAX_AMOUNT_CENTS, msisdnLast4 } from "../types"

const SECRET = "test-mpesa-secret"
const NOW = new Date("2026-11-08T09:00:00Z")
const T = "t_ke"

function signed(body: unknown, opts: { secret?: string; at?: Date; tenantId?: string } = {}) {
  const rawBody = JSON.stringify(body)
  const ts = Math.floor((opts.at ?? NOW).getTime() / 1000)
  const headers = new Headers({
    "x-simulated-timestamp": String(ts),
    "x-simulated-signature": signSimulatedCallback(rawBody, opts.secret ?? SECRET, ts, opts.tenantId ?? T),
  })
  return { rawBody, headers }
}

const c2b = { type: "C2B", transId: "SIM0000001", billRef: " nrb-ln-1 ", amount: "1500.00", msisdn: "254712345678", transTime: "2026-11-08T08:59:00Z" }

describe("simulated M-Pesa callbacks", () => {
  beforeEach(() => { vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", SECRET) })
  afterEach(() => { vi.unstubAllEnvs() })

  it("parses a signed paybill payment, keeping only the phone's last four digits", () => {
    const parsed = simulatedMpesa.parseCallback({ tenantId: T, ...signed(c2b), now: NOW })
    expect(parsed).toEqual({
      kind: "C2B", transId: "SIM0000001", billRef: "nrb-ln-1", amountCents: 150_000,
      msisdnLast4: "5678", transactedAt: new Date("2026-11-08T08:59:00Z"),
    })
    expect(JSON.stringify(parsed)).not.toContain("254712345678")
  })

  it("refuses a bad signature, another secret, a stale timestamp and an unset secret", () => {
    const good = signed(c2b)
    const tampered = { rawBody: good.rawBody.replace("1500.00", "9500.00"), headers: good.headers }
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...tampered, now: NOW })).toBeNull()
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...signed(c2b, { secret: "other" }), now: NOW })).toBeNull()
    const stale = new Date(NOW.getTime() - (CALLBACK_TOLERANCE_SECONDS + 1) * 1000)
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...signed(c2b, { at: stale }), now: NOW })).toBeNull()
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "")
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...good, now: NOW })).toBeNull()
  })

  it("refuses a callback signed for another lender: the tenant is part of the signed material", () => {
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...signed(c2b, { tenantId: "t_other" }), now: NOW })).toBeNull()
    expect(simulatedMpesa.parseCallback({ tenantId: "t_other", ...signed(c2b), now: NOW })).toBeNull()
  })

  it("names its signature header, so the webhook can refuse an unsigned request before reading it", () => {
    expect(simulatedMpesa.signatureHeader).toBe("x-simulated-signature")
  })

  it("refuses every callback on a deployed build that does not permit simulated-mpesa", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-payout")
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...signed(c2b), now: NOW })).toBeNull()
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-mpesa")
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...signed(c2b), now: NOW })).not.toBeNull()
  })

  it("refuses a signed body with a zero, negative or unparseable amount", () => {
    for (const amount of ["0", "-5", "12.345", "abc", ""]) {
      expect(simulatedMpesa.parseCallback({ tenantId: T, ...signed({ ...c2b, amount }), now: NOW }), amount).toBeNull()
    }
  })

  it("builds a signed paybill payment that parses back", () => {
    const cb = simulatedC2BPayment({ tenantId: T, transId: "SIMABC1234", billRef: "NRB-LN-1", amountCents: 50_000, msisdn: "254700000001", now: NOW })
    expect(simulatedMpesa.parseCallback({ tenantId: T, ...cb, now: NOW })).toMatchObject({ kind: "C2B", transId: "SIMABC1234", amountCents: 50_000, msisdnLast4: "0001" })
  })
})

describe("simulated STK push", () => {
  beforeEach(() => { vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", SECRET) })
  afterEach(() => { vi.unstubAllEnvs() })

  const push = (msisdn: string) => simulatedMpesa.requestStkPush({ tenantId: T, msisdn, amountCents: 120_000, accountReference: "NRB-LN-1" })

  it("delivers its own signed PAID callback for the request it accepted", async () => {
    const result = await push("254712345678")
    if (result.kind !== "accepted" || !result.callback) throw new Error("expected an accepted push with a callback")
    const parsed = simulatedMpesa.parseCallback({ ...result.callback, tenantId: T })
    expect(parsed).toMatchObject({ kind: "STK_PAID", checkoutRequestId: result.checkoutRequestId, amountCents: 120_000, msisdnLast4: "5678" })
    expect(result.callback.rawBody).not.toContain("254712345678")
  })

  it("a phone ending 0000 is cancelled by the user", async () => {
    const result = await push("254712340000")
    if (result.kind !== "accepted" || !result.callback) throw new Error("expected an accepted push with a callback")
    expect(simulatedMpesa.parseCallback({ ...result.callback, tenantId: T })).toMatchObject({ kind: "STK_CANCELLED", checkoutRequestId: result.checkoutRequestId })
  })

  it("is refused on a deployed build that does not permit simulated-mpesa, and without a secret", async () => {
    vi.stubEnv("NODE_ENV", "production")
    await expect(push("254712345678")).rejects.toThrow(/simulated-mpesa/)
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "")
    expect(await push("254712345678")).toMatchObject({ kind: "rejected" })
  })
})

describe("amounts and phones", () => {
  it("converts exact decimal amounts to cents and refuses the rest", () => {
    expect(amountToCents("100")).toBe(10_000)
    expect(amountToCents("100.5")).toBe(10_050)
    expect(amountToCents(" 1.05 ")).toBe(105)
    expect(amountToCents("0.00")).toBeNull()
    expect(amountToCents("1e3")).toBeNull()
    // Anything a 4-byte cents column cannot hold is refused, not a 500 later.
    expect(amountToCents((MAX_AMOUNT_CENTS / 100).toFixed(2))).toBe(MAX_AMOUNT_CENTS)
    expect(amountToCents(((MAX_AMOUNT_CENTS + 1) / 100).toFixed(2))).toBeNull()
    expect(amountToCents("30000000.00")).toBeNull()
  })

  it("keeps the last four digits only", () => {
    expect(msisdnLast4("+254 712 345 678")).toBe("5678")
    expect(msisdnLast4("12")).toBeNull()
    expect(msisdnLast4(null)).toBeNull()
  })
})
