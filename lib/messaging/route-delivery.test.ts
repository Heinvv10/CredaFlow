/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { templateFindFirst, contactIdentityFindFirst, sendMessage } = vi.hoisted(() => ({
  templateFindFirst: vi.fn(),
  contactIdentityFindFirst: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    messageTemplate: { findFirst: templateFindFirst },
    contactIdentity: { findFirst: contactIdentityFindFirst },
  },
}))
vi.mock("./send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send")>()),
  sendMessage,
}))

import { deliverViaMessaging, resolveMessagingTarget } from "./route-delivery"
import { SendBlockedError } from "./send"
import { MessageReconciliationRequiredError } from "./dispatch-control"
import { ProviderDispatchError } from "./providers"

const opts = { contactId: "ct1", channel: "EMAIL", template: {}, vars: {}, toValue: "x@y.com" } as any

describe("resolveMessagingTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    contactIdentityFindFirst.mockResolvedValue({ contact: { id: "ct1" } })
  })

  it("only matches an ACTIVE template — a deactivated one must stop sending", async () => {
    templateFindFirst.mockResolvedValue(null)

    const r = await resolveMessagingTarget({
      tenantId: "tn1", channel: "EMAIL", value: "x@y.com", templateKey: "k",
    })

    expect(templateFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ active: true }),
    }))
    expect(r.ok).toBe(false)
  })

  it("reports a missing Contact row rather than returning a usable target", async () => {
    contactIdentityFindFirst.mockResolvedValue(null)

    const r = await resolveMessagingTarget({
      tenantId: "tn1", channel: "EMAIL", value: "x@y.com", templateKey: "k",
    })

    expect(r.ok).toBe(false)
    expect(templateFindFirst).not.toHaveBeenCalled()
  })
})

describe("deliverViaMessaging", () => {
  beforeEach(() => vi.clearAllMocks())

  it("reports a SIMULATED dispatch as simulated — never as a real send", async () => {
    // BULKSMS_DRY_RUN is true on prod. A caller that audits this as sent
    // writes a false compliance record for a notice that never left.
    sendMessage.mockImplementation(async (o: any) => {
      o.onProviderDispatchStart?.()
      return { status: "SIMULATED", dispatchState: "SIMULATED", simulationReceiptId: "sim-1" }
    })

    expect(await deliverViaMessaging(opts)).toEqual({
      ok: true, simulated: true, providerOutcome: "ACCEPTED",
    })
  })

  it("reports a real provider acceptance as not simulated", async () => {
    sendMessage.mockImplementation(async (o: any) => {
      o.onProviderDispatchStart?.()
      return { status: "SENT", dispatchState: "ACCEPTED", simulationReceiptId: null }
    })

    expect(await deliverViaMessaging(opts)).toEqual({
      ok: true, simulated: false, providerOutcome: "ACCEPTED",
    })
  })

  it("calls a pre-dispatch throw a DEFINITE non-delivery, not an ambiguity", async () => {
    // resolveProvider's "Email is not configured", renderTemplate's missing-var
    // throw, assertRedactedSendIsRecoverable, MessageIdempotencyConflictError,
    // any Prisma error in the reservation — none of them reach a provider. The
    // callers turn AMBIGUOUS into a POPIA disclosure record and tell the
    // officer the document may have reached the client, so mislabelling these
    // forges a disclosure for a send that never happened. Legacy sendEmail()
    // already returned DEFINITELY_REJECTED for the no-config case.
    sendMessage.mockRejectedValue(new Error("Email is not configured for this tenant"))

    expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({
      ok: false, providerOutcome: "DEFINITELY_REJECTED",
    }))
  })

  it("keeps AMBIGUOUS when the provider WAS invoked and the error is untyped", async () => {
    // Same untyped error, but dispatch was entered — it may have arrived.
    // AMBIGUOUS stays the fail-safe default here.
    sendMessage.mockImplementation(async (o: any) => {
      o.onProviderDispatchStart?.()
      throw new Error("socket hang up")
    })

    expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({
      ok: false, providerOutcome: "AMBIGUOUS",
    }))
  })

  it("chains a caller-supplied onProviderDispatchStart rather than replacing it", async () => {
    const callerHook = vi.fn()
    sendMessage.mockImplementation(async (o: any) => {
      o.onProviderDispatchStart?.()
      return { status: "SENT", dispatchState: "ACCEPTED", simulationReceiptId: null }
    })

    await deliverViaMessaging({ ...opts, onProviderDispatchStart: callerHook })

    expect(callerHook).toHaveBeenCalledOnce()
  })

  it("stays AMBIGUOUS on a reconciliation error even when THIS call touched no provider", async () => {
    // MessageReconciliationRequiredError also covers the idempotent-replay
    // branch, where an EARLIER attempt on the same reservation may have been
    // delivered. This call not reaching a provider says nothing about that one.
    sendMessage.mockRejectedValue(new MessageReconciliationRequiredError({ id: "m1" } as any, "replay"))

    expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({
      ok: false, providerOutcome: "AMBIGUOUS",
    }))
  })

  it.each(["FAILED_PERMANENT", "RETRYING", "SUPPRESSED_BY_CONSENT", "EXPIRED", "BOUNCED", "QUEUED"])(
    "does not report a returned %s message as a successful send",
    async (status) => {
      // sendMessage RETURNS these rather than throwing when it owns the retry.
      // Unreachable only while every caller passes automaticRetry:false — the
      // same incidental protection made explicit for the retry guard.
      sendMessage.mockImplementation(async (o: any) => {
        o.onProviderDispatchStart?.()
        return { status, dispatchState: "DEFINITELY_REJECTED", errorMessage: "provider said no" }
      })

      expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({ ok: false }))
    },
  )

  it("treats an eligibility block as a definite non-delivery", async () => {
    sendMessage.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({
      ok: false, providerOutcome: "DEFINITELY_REJECTED",
    }))
  })

  it("never collapses an ambiguous outcome into a definite rejection", async () => {
    sendMessage.mockRejectedValue(new MessageReconciliationRequiredError({ id: "m1" } as any, "uncertain"))

    expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({
      ok: false, providerOutcome: "AMBIGUOUS",
    }))
  })

  it("preserves a provider's DEFINITELY_REJECTED verdict", async () => {
    sendMessage.mockRejectedValue(new ProviderDispatchError("bad address", "DEFINITELY_REJECTED"))

    expect(await deliverViaMessaging(opts)).toEqual(expect.objectContaining({
      ok: false, providerOutcome: "DEFINITELY_REJECTED",
    }))
  })
})
