import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakePayoutDb, payoutRow } from "./payouts.test-helpers"
import { signSimulatedWebhook, simulatedPayouts } from "./providers/simulated"
import { ingestNotification, parseResolveAction, resolvePayout } from "./resolve"
import { canTransition, nextFromProvider, PAYOUT_STATUSES, statusAfterSend } from "./state"

const actor = { id: "u-1", email: "staff@test.invalid" }

describe("payout state machine", () => {
  it("reaches PENDING only by approving a retry, and nothing leaves FAILED, RETURNED or CANCELLED", () => {
    for (const from of PAYOUT_STATUSES) expect(canTransition(from, "PENDING")).toBe(from === "AWAITING_APPROVAL")
    for (const to of PAYOUT_STATUSES) {
      expect(canTransition("FAILED", to)).toBe(false)
      expect(canTransition("RETURNED", to)).toBe(false)
      expect(canTransition("CANCELLED", to)).toBe(false)
    }
  })

  it("ignores repeated and out-of-order provider reports, and never settles a payout under review", () => {
    expect(nextFromProvider("PAID", "SUBMITTED")).toBeNull()
    expect(nextFromProvider("PAID", "PAID")).toBeNull()
    expect(nextFromProvider("SUBMITTED", "PAID")).toBe("PAID")
    expect(nextFromProvider("PAID", "RETURNED")).toBe("RETURNED")
    expect(nextFromProvider("NEEDS_REVIEW", "PAID")).toBeNull()
    expect(statusAfterSend("RETURNED")).toBe("NEEDS_REVIEW")
  })
})

describe("resolvePayout — staff actions", () => {
  it("requires a note to confirm", () => {
    expect(parseResolveAction({ action: "confirm_paid", note: "ok" })).toBeNull()
    expect(parseResolveAction({ action: "confirm_failed", note: "Bank says account closed" })).toMatchObject({ action: "confirm_failed" })
    expect(parseResolveAction({ action: "retry" })).toBeNull()
  })

  it("confirms a payout under review, naming who and why", async () => {
    const { db, rows } = fakePayoutDb([payoutRow({ status: "NEEDS_REVIEW" })])
    const out = await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "confirm_paid", note: "Seen on Netcash report 14 Oct", providerReference: "NC-1" } })
    expect(out).toEqual({ ok: true, status: "PAID", changed: true })
    expect(rows[0]).toMatchObject({ status: "PAID", resolvedById: "u-1", resolutionNote: "Seen on Netcash report 14 Oct", providerReference: "NC-1" })
    expect(rows[0].resolvedAt).toBeInstanceOf(Date)
  })

  it("refuses the disburser or the attempt's requester as the confirmer (maker-checker), and audits it", async () => {
    for (const who of ["u-disburser", "u-requester"]) {
      const { db, rows, audits } = fakePayoutDb([payoutRow({ status: "NEEDS_REVIEW", createdById: "u-requester" })])
      const out = await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor: { id: who, email: "x@test.invalid" }, request: { action: "confirm_paid", note: "Seen on the report" } })
      expect(out).toMatchObject({ ok: false, status: 403 })
      expect(rows[0].status).toBe("NEEDS_REVIEW")
      expect(audits.map((a) => a.action)).toEqual(["PAYOUT_ACTION_REFUSED"])
    }
  })

  it("records the bank's value date given with a confirmation, and refuses one in the future", async () => {
    expect(parseResolveAction({ action: "confirm_paid", note: "On the Netcash report", paidAt: "2999-01-01" })).toBeNull()
    const request = parseResolveAction({ action: "confirm_paid", note: "On the Netcash report", paidAt: "2026-10-12" })!
    const { db, rows } = fakePayoutDb([payoutRow({ status: "SUBMITTED", provider: "netcash" })])
    expect(await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request })).toMatchObject({ ok: true, status: "PAID" })
    expect(rows[0].paidAt?.toISOString()).toBe(new Date("2026-10-12T12:00:00+02:00").toISOString())
  })

  it("refuses the attempt's approver as the confirmer", async () => {
    const { db } = fakePayoutDb([payoutRow({ status: "NEEDS_REVIEW", approvedById: "u-1" })])
    expect(await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "confirm_failed", note: "Not on the report" } })).toMatchObject({ ok: false, status: 403 })
  })

  it("refuses to confirm a payout that is settled or never sent", async () => {
    for (const status of ["PENDING", "PAID", "FAILED"] as const) {
      const { db } = fakePayoutDb([payoutRow({ status })])
      const out = await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "confirm_failed", note: "nothing arrived" } })
      expect(out).toMatchObject({ ok: false, status: 409 })
    }
  })

  it("sends only a payout that was never sent", async () => {
    const { db } = fakePayoutDb([payoutRow({ status: "NEEDS_REVIEW" })])
    expect(await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "send" } })).toMatchObject({ ok: false, status: 409 })
  })

  it("moves a stale claim with no recorded answer to review, not to a resend", async () => {
    const submittedAt = new Date("2026-10-14T08:00:00Z")
    const { db, rows } = fakePayoutDb([payoutRow({ status: "SUBMITTING", submittedAt })])
    const early = await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "check" }, now: new Date("2026-10-14T08:05:00Z") })
    expect(early).toMatchObject({ ok: false, status: 409 })
    const late = await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "check" }, now: new Date("2026-10-14T08:11:00Z") })
    expect(late).toEqual({ ok: true, status: "NEEDS_REVIEW", changed: true })
    expect(rows[0].status).toBe("NEEDS_REVIEW")
  })

  it("asks a provider that can be asked, and records its answer", async () => {
    const { db, rows } = fakePayoutDb([payoutRow({ status: "SUBMITTED", providerReference: "sim-disburse:app-1-1111" })])
    const out = await resolvePayout(db, { tenantId: "t-1", payoutId: "po-1", actor, request: { action: "check" } })
    expect(out).toEqual({ ok: true, status: "FAILED", changed: true })
    expect(rows[0].failureReason).toContain("account closed")
  })
})

describe("webhook ingestion (simulated provider)", () => {
  beforeEach(() => vi.stubEnv("SIMULATED_PAYOUT_WEBHOOK_SECRET", "test-secret"))
  afterEach(() => vi.unstubAllEnvs())

  const body = JSON.stringify({ providerReference: "sim-disburse:app-1-1234", idempotencyKey: "disburse:app-1", state: "PAID" })
  const now = new Date("2026-10-15T08:00:00Z")
  const ts = Math.floor(now.getTime() / 1000)
  const signed = (t: number, secret = "test-secret") =>
    new Headers({ "x-simulated-timestamp": String(t), "x-simulated-signature": signSimulatedWebhook(body, secret, t) })

  it("refuses an unsigned or wrongly signed notification", () => {
    expect(simulatedPayouts.parseWebhook!({ rawBody: body, headers: new Headers(), now })).toBeNull()
    expect(simulatedPayouts.parseWebhook!({ rawBody: body, headers: signed(ts, "other"), now })).toBeNull()
  })

  it("refuses a correctly signed notification older (or newer) than five minutes: no replay", () => {
    expect(simulatedPayouts.parseWebhook!({ rawBody: body, headers: signed(ts - 299), now })).not.toBeNull()
    expect(simulatedPayouts.parseWebhook!({ rawBody: body, headers: signed(ts - 301), now })).toBeNull()
    expect(simulatedPayouts.parseWebhook!({ rawBody: body, headers: signed(ts + 301), now })).toBeNull()
  })

  it("applies a signed notification once; a repeat changes nothing", async () => {
    const { db, rows, audits } = fakePayoutDb([payoutRow({ status: "SUBMITTED", providerReference: "sim-disburse:app-1-1234" })])
    const notification = simulatedPayouts.parseWebhook!({ rawBody: body, headers: signed(ts), now })!
    expect(await ingestNotification(db, { tenantId: "t-1", providerId: "simulated", notification })).toEqual({ matched: true, status: "PAID", changed: true })
    expect(await ingestNotification(db, { tenantId: "t-1", providerId: "simulated", notification })).toEqual({ matched: true, status: "PAID", changed: false })
    expect(rows[0].status).toBe("PAID")
    expect(audits).toHaveLength(1)
  })

  it("does not match another tenant's or another provider's payout", async () => {
    const { db } = fakePayoutDb([payoutRow({ status: "SUBMITTED" })])
    const notification = { providerReference: null, idempotencyKey: "disburse:app-1", state: "PAID" as const }
    expect(await ingestNotification(db, { tenantId: "t-2", providerId: "simulated", notification })).toEqual({ matched: false })
    expect(await ingestNotification(db, { tenantId: "t-1", providerId: "netcash", notification })).toEqual({ matched: false })
  })
})
