/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  noteFindFirst: vi.fn(),
  noteCreate: vi.fn(),
  sendEmail: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendWhatsAppBridge: vi.fn(),
  availability: vi.fn(),
  templateFindFirst: vi.fn(),
  sendMessage: vi.fn(),
  charges: vi.fn(),
  dueEmail: vi.fn((..._a: any[]) => "<p>html</p>"),
  waDue3d: vi.fn((..._a: any[]) => "wa body"),
}))

const holds = vi.hoisted(() => ({ held: false }))
vi.mock("@/lib/collections/client-holds", () => ({ isLoanHeld: async () => holds.held }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    repaymentSchedule: { findMany: (...a: any[]) => h.findMany(...a) },
    loanNote: {
      findFirst: (...a: any[]) => h.noteFindFirst(...a),
      create: (...a: any[]) => h.noteCreate(...a),
    },
    messageTemplate: { findFirst: (...a: any[]) => h.templateFindFirst(...a) },
  },
}))
// Only sendMessage is stubbed. SendBlockedError comes through as the REAL
// class, so the route's `err instanceof SendBlockedError` and the class this
// test throws are the same constructor — stubbing it too would make the
// instanceof check silently false and the test vacuous.
vi.mock("@/lib/messaging/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/send")>()),
  sendMessage: (...a: any[]) => h.sendMessage(...a),
}))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => null }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: async () => "t1" }))
vi.mock("@/lib/config/identity", async (orig) => {
  const actual = await orig<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { ...actual, getLenderIdentity: async () => actual.parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: async () => ({ whatsappEnabled: true, waProvider: "WA_CLOUD" }) }))
vi.mock("@/lib/email/service", () => ({ sendEmail: (...a: any[]) => h.sendEmail(...a) }))
vi.mock("@/lib/whatsapp-cloud", () => ({
  sendWhatsAppCloudMessage: (...a: any[]) => h.sendWhatsApp(...a),
}))
vi.mock("@/lib/whatsapp", () => ({
  // Deliberately NOT wired to h.sendWhatsApp: WA_CLOUD is the provider, so reaching
  // the bridge sender from this cron is a defect the suite must catch.
  sendWhatsAppMessage: (...a: any[]) => h.sendWhatsAppBridge(...a),
  WA_TEMPLATES: { payment_due_3d: (...a: any[]) => h.waDue3d(...a) },
}))
vi.mock("@/lib/email/templates/portal", () => ({ paymentDueReminderEmail: (...a: any[]) => h.dueEmail(...a) }))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesOutstandingAt: (...a: any[]) => h.charges(...a) }))
vi.mock("@/lib/utils", () => ({ formatDate: (d: Date) => d.toISOString().slice(0, 10) }))
vi.mock("@/lib/messaging/channel-availability", () => ({
  getChannelAvailability: (...a: any[]) => h.availability(...a),
}))

import { GET } from "./route"
import { SendBlockedError } from "@/lib/messaging/send"
import { sastStartOfDay } from "@/lib/date/sast"
import { remindableLoanWhere } from "@/lib/collections/dunning-holds"

const CONTACT = {
  id: "c1",
  primaryEmail: "client@example.com",
  primaryPhone: "+27820000000",
  primaryWaJid: "27820000000@s.whatsapp.net",
  blockedAt: null,
  status: "ACTIVE",
}

/** A schedule due exactly `days` from now, at midday to avoid boundary noise. */
function scheduleDueIn(days: number, id = "s1") {
  const d = new Date(sastStartOfDay(new Date()).getTime() + days * 86_400_000 + 12 * 3_600_000)
  return {
    id,
    dueDate: d,
    totalDue: 150000,
    totalPaid: 0,
    loan: {
      id: "l1",
      reference: "LN-001",
      client: { firstName: "Sipho", lastName: "Dlamini", contact: { ...CONTACT } },
    },
  }
}

const allChannelsOpen = {
  EMAIL: { enabled: true, toValue: "client@example.com" },
  WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
  SMS: { enabled: false, reason: "SMS not enabled" },
}

const run = () => GET({} as any)

beforeEach(() => {
  vi.clearAllMocks()
  h.noteFindFirst.mockResolvedValue(null)
  h.noteCreate.mockResolvedValue({})
  h.sendEmail.mockResolvedValue({ ok: true, messageId: "m1" })
  h.sendWhatsApp.mockResolvedValue({ ok: true })
  h.sendWhatsAppBridge.mockResolvedValue({ ok: true })
  h.availability.mockResolvedValue(allChannelsOpen)
  h.charges.mockResolvedValue(0)
  delete process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS
})

describe("payment-reminders — one send per instalment", () => {
  // The schedules are selected once at the start of the run; the hold is rechecked per send.
  it("skips a schedule whose loan was put on a dunning hold after the run started", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    holds.held = true
    try {
      const res = await run()
      expect(await res.json()).toMatchObject({ sent: 0, skipped: 1 })
      expect(h.sendEmail).not.toHaveBeenCalled()
      expect(h.sendWhatsApp).not.toHaveBeenCalled()
    } finally {
      holds.held = false
    }
  })

  // The query is the control, not a post-filter: the real-Postgres proof that
  // each held loan is unreached is lib/collections/dunning-holds.integration.test.ts.
  it("selects only remindable loans: the shared dunning-hold predicate, not just 'not CANCELLED'", async () => {
    h.findMany.mockResolvedValue([])
    await run()
    expect(h.findMany.mock.calls[0][0].where.loan).toEqual(remindableLoanWhere())
    expect(h.findMany.mock.calls[0][0].where.loan.status).toBe("ACTIVE")
  })

  it("sends for a schedule due in 3 days", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 1, due: 1 })
    expect(h.sendEmail).toHaveBeenCalledOnce()
    expect(h.sendWhatsApp).toHaveBeenCalledOnce()
  })

  it.each([4, 5])("ignores a schedule due in %i days — outside the window", async (days) => {
    h.findMany.mockResolvedValue([scheduleDueIn(days)])
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, due: 0 })
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it("ignores a schedule already past due", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(-1)])
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, due: 0 })
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  // Once per instalment. Mailing everything due within 3 days on every run
  // would give one instalment four reminders on consecutive days across both
  // channels. Simulated here as four daily runs over the same instalment,
  // with the marker persisting between them the way the database would.
  it("four daily runs over the same instalment produce ONE send, not four", async () => {
    let marker: unknown = null
    let emails = 0
    let whatsapps = 0

    for (const days of [3, 2, 1, 0]) {
      vi.clearAllMocks()
      h.sendEmail.mockResolvedValue({ ok: true, messageId: "m1" })
      h.sendWhatsApp.mockResolvedValue({ ok: true })
  h.sendWhatsAppBridge.mockResolvedValue({ ok: true })
      h.availability.mockResolvedValue(allChannelsOpen)
      h.noteFindFirst.mockImplementation(async () => marker)
      h.noteCreate.mockImplementation(async () => {
        marker = { id: "note-1" }
        return marker
      })
      h.findMany.mockResolvedValue([scheduleDueIn(days)])

      await run()
      emails += h.sendEmail.mock.calls.length
      whatsapps += h.sendWhatsApp.mock.calls.length
    }

    expect(emails).toBe(1)
    expect(whatsapps).toBe(1)
  })
})

describe("payment-reminders — a failed send is retried, not lost", () => {
  it("writes NO marker when every allowed channel was DEFINITELY rejected", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.sendEmail.mockResolvedValue({ ok: false, error: "smtp 550", providerOutcome: "DEFINITELY_REJECTED" })
    h.sendWhatsApp.mockResolvedValue({ ok: false, error: "gateway down", providerOutcome: "DEFINITELY_REJECTED" })
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, failed: 1 })
    // A marker here would suppress every future attempt and lose the reminder.
    expect(h.noteCreate).not.toHaveBeenCalled()
  })

  it("retries on the next run after a failure, then marks it once delivered", async () => {
    let marker: unknown = null
    h.noteFindFirst.mockImplementation(async () => marker)
    h.noteCreate.mockImplementation(async () => {
      marker = { id: "note-1" }
      return marker
    })

    // Day 3 — everything fails.
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.sendEmail.mockResolvedValue({ ok: false, error: "smtp 550", providerOutcome: "DEFINITELY_REJECTED" })
    h.sendWhatsApp.mockResolvedValue({ ok: false, error: "gateway down", providerOutcome: "DEFINITELY_REJECTED" })
    await run()
    expect(marker).toBeNull()

    // Day 2 — still inside the window, so it is picked up again and succeeds.
    h.sendEmail.mockResolvedValue({ ok: true, messageId: "m1" })
    h.sendWhatsApp.mockResolvedValue({ ok: true })
  h.sendWhatsAppBridge.mockResolvedValue({ ok: true })
    h.findMany.mockResolvedValue([scheduleDueIn(2)])
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 1 })
    expect(marker).not.toBeNull()
  })

  it("does NOT count a WhatsApp rejection as delivered (it resolves ok:false, it does not throw)", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "No email on file" },
      WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    h.sendWhatsApp.mockResolvedValue({ ok: false, error: "not on WhatsApp", providerOutcome: "DEFINITELY_REJECTED" })
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, failed: 1 })
    expect(h.noteCreate).not.toHaveBeenCalled()
  })
})

// An AMBIGUOUS outcome means the provider MAY already have dispatched — a
// timeout after Graph accepted, or a WA 2xx carrying no message id. Replaying
// that recreates the exact duplicate this route must not send, so
// ambiguity must BLOCK the retry even though nothing is confirmed delivered.
describe("payment-reminders — an ambiguous outcome blocks replay", () => {
  it("marks (does not retry) when email is AMBIGUOUS", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: true, toValue: "client@example.com" },
      WHATSAPP: { enabled: false, reason: "WhatsApp channel is off" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    h.sendEmail.mockResolvedValue({ ok: false, error: "timeout", providerOutcome: "AMBIGUOUS" })
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, failed: 0, needsReconciliation: 1 })
    expect(h.noteCreate).toHaveBeenCalledOnce()
    expect(h.noteCreate.mock.calls[0][0].data.note).toContain("AMBIGUOUS")
  })

  it("marks (does not retry) when WhatsApp returns success without a message id", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "No email on file" },
      WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    h.sendWhatsApp.mockResolvedValue({
      ok: false,
      error: "WA Sender returned success without a provider message id",
      providerOutcome: "AMBIGUOUS",
    })
    const res = await run()
    expect(await res.json()).toMatchObject({ needsReconciliation: 1 })
    expect(h.noteCreate).toHaveBeenCalledOnce()
  })

  it("a mix of definite rejection and ambiguity still blocks replay", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.sendEmail.mockResolvedValue({ ok: false, error: "smtp 550", providerOutcome: "DEFINITELY_REJECTED" })
    h.sendWhatsApp.mockResolvedValue({ ok: false, error: "timeout", providerOutcome: "AMBIGUOUS" })
    const res = await run()
    expect(await res.json()).toMatchObject({ needsReconciliation: 1, failed: 0 })
    expect(h.noteCreate).toHaveBeenCalledOnce()
  })

  it("an unclassified WhatsApp throw is treated as ambiguous, not replayed", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "No email on file" },
      WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    h.sendWhatsApp.mockRejectedValue(new Error("socket hang up"))
    const res = await run()
    expect(await res.json()).toMatchObject({ needsReconciliation: 1 })
    expect(h.noteCreate).toHaveBeenCalledOnce()
  })
})

describe("payment-reminders — idempotency", () => {
  it("skips a loan already reminded for this instalment", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.noteFindFirst.mockResolvedValue({ id: "note-1" })
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, skipped: 1 })
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.sendWhatsApp).not.toHaveBeenCalled()
  })

  it("writes the durable LoanNote marker after sending", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    await run()
    expect(h.noteCreate).toHaveBeenCalledOnce()
    expect(h.noteCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      loanId: "l1",
      type: "payment_due_reminder",
      createdBy: "system",
    })
  })
})

describe("payment-reminders — consent", () => {
  it("sends nothing when the contact is blocked / opted out", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, toValue: "client@example.com", reason: "Client opted out" },
      WHATSAPP: { enabled: false, toValue: "27820000000@s.whatsapp.net", reason: "Do not contact" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, suppressed: 1 })
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.sendWhatsApp).not.toHaveBeenCalled()
  })

  it("still records a marker when everything was suppressed, so the run stays idempotent", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "Client opted out" },
      WHATSAPP: { enabled: false, reason: "Client opted out" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    await run()
    expect(h.noteCreate).toHaveBeenCalledOnce()
    expect(h.noteCreate.mock.calls[0][0].data.note).toContain("not sent")
  })

  it("honours a per-channel decision — email suppressed, WhatsApp still allowed", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "Client opted out" },
      WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    const res = await run()
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.sendWhatsApp).toHaveBeenCalledOnce()
    expect(await res.json()).toMatchObject({ sent: 1 })
  })

  it("suppresses a client with no contact record rather than falling back to raw fields", async () => {
    const s = scheduleDueIn(3)
    ;(s.loan.client as any).contact = null
    h.findMany.mockResolvedValue([s])
    const res = await run()
    expect(await res.json()).toMatchObject({ sent: 0, suppressed: 1 })
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.sendWhatsApp).not.toHaveBeenCalled()
    // No contact means no consent record to rely on, so not even a marker send.
    expect(h.availability).not.toHaveBeenCalled()
  })

  it("addresses the message to the identity consent was evaluated for", async () => {
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.availability.mockResolvedValue({
      ...allChannelsOpen,
      EMAIL: { enabled: true, toValue: "preferred@example.com" },
    })
    await run()
    expect(h.sendEmail.mock.calls[0][0].to).toBe("preferred@example.com")
  })
})

// WA_CLOUD is the provider. Reverting this cron to the bridge sender would
// pass the entire suite if the settings stub carried no waProvider, because
// the helper would fall through to the bridge branch and land on the same mock.
it("sends via the tenant's Cloud provider, with the contact so the 24h window can be read", async () => {
  h.findMany.mockResolvedValue([scheduleDueIn(3)])
  const res = await run()
  expect(res.status).toBe(200)
  expect(h.sendWhatsAppBridge).not.toHaveBeenCalled()
  expect(h.sendWhatsApp).toHaveBeenCalled()
  const arg = h.sendWhatsApp.mock.calls[0][0]
  expect(arg.tenantId).toBe("t1")
  expect(arg.contactId).toBeTruthy()
})

describe("payment-reminders — WABA template path (MESSAGING_NEW_SEND_PAYMENT_REMINDERS)", () => {
  const TEMPLATE = {
    id: "tpl-pd3",
    tenantId: "t1",
    key: "payment_due_3d_whatsapp",
    channel: "WHATSAPP",
    active: true,
    statutoryOverride: false,
    bodyTemplate:
      "Hi {{firstName}},\n\nReminder: A payment of *{{amount}}* is due on *{{dueDate}}*.\n\n"
      + "Payment reference: *{{reference}}*\n\nPlease ensure funds are available. "
      + "Log in to the portal to pay or view your schedule.",
  }

  beforeEach(() => {
    process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS = "true"
    h.findMany.mockResolvedValue([scheduleDueIn(3)])
    h.templateFindFirst.mockResolvedValue(TEMPLATE)
    h.sendMessage.mockResolvedValue({ status: "SENT", id: "m-wa-1" })
  })

  it("sends through sendMessage() with the template, never the free-text sender", async () => {
    await run()

    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    const arg = h.sendMessage.mock.calls[0][0]
    expect(arg.channel).toBe("WHATSAPP")
    expect(arg.template.key).toBe("payment_due_3d_whatsapp")
    // The whole point of the migration: the free-text senders carry no
    // template, so on WA_CLOUD they can only ever succeed inside the 24h
    // window — which an unprompted reminder is by definition outside.
    expect(h.sendWhatsApp).not.toHaveBeenCalled()
    expect(h.sendWhatsAppBridge).not.toHaveBeenCalled()
  })

  it("supplies a value for every placeholder its registered body declares", async () => {
    await run()

    const { vars } = h.sendMessage.mock.calls[0][0]
    const placeholders = [...TEMPLATE.bodyTemplate.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    // send.ts drops the template when ANY placeholder is absent OR blank, then
    // fails out-of-window — so an unfilled var is indistinguishable from having
    // no template at all, and nothing says why.
    for (const p of placeholders) {
      expect(vars[p] ?? "", `no value for {{${p}}}`).not.toBe("")
    }
    expect(vars.body, "the {{body}} envelope belongs to the OTHER reminder cron").toBeUndefined()
  })

  it("keys idempotency on the SCHEDULE, so a later instalment still earns its reminder", async () => {
    await run()

    const { idempotencyKey } = h.sendMessage.mock.calls[0][0]
    expect(idempotencyKey).toContain("s1")
    // Must not collide with lib/collections/reminders.ts, which reminds the
    // same borrower about the same loan on different days.
    expect(idempotencyKey.startsWith("collections:")).toBe(false)
  })

  // sendMessage() replays an existing reservation for a repeated key WITHOUT
  // dispatching. A key fixed for the whole reminder window would therefore turn
  // one PERMANENT failure into permanent silence for that borrower, while the
  // cron kept reporting "failed, will retry".
  it("varies the reservation key per day, so a failed day is genuinely re-attempted", async () => {
    // Fake timers, not a Date.now spy: the route reads `new Date()`, which a
    // Date.now stub does not affect, so a stub would let a fixed
    // key through unnoticed.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-08-18T07:00:00Z"))
      h.findMany.mockResolvedValue([scheduleDueIn(3)])
      await run()
      const day1 = h.sendMessage.mock.calls[0][0].idempotencyKey

      // Next morning. Same schedule, still inside the window, still unmarked
      // because the previous attempt did not deliver.
      vi.setSystemTime(new Date("2026-08-19T07:00:00Z"))
      h.sendMessage.mockClear()
      h.findMany.mockResolvedValue([scheduleDueIn(2)])
      await run()
      const day2 = h.sendMessage.mock.calls[0][0].idempotencyKey

      expect(day1).toContain("2026-08-18")
      expect(day2).toContain("2026-08-19")
      expect(day2).not.toBe(day1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keys the reservation on the SAST day, so a 00:30 send is not repeated at 08:00", async () => {
    // A reservation key built from LOCAL date parts would, in a UTC container,
    // roll the "one send per day" window over at 02:00 SAST. A reminder
    // dispatched at 00:30 would be filed under YESTERDAY, and the same
    // morning's run would get a different key and dispatch again: the borrower
    // receives the same notice twice before breakfast.
    //
    // Note this shape is invisible to scripts/check-date-boundaries.ts — the
    // key is assembled from getters into a string and never constructs a Date.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-08-19T22:30:00Z")) // 00:30 SAST on 20 Aug
      h.findMany.mockResolvedValue([scheduleDueIn(3)])
      await run()
      const midnight = h.sendMessage.mock.calls[0][0].idempotencyKey

      vi.setSystemTime(new Date("2026-08-20T06:00:00Z")) // 08:00 SAST, SAME SAST day
      h.sendMessage.mockClear()
      h.findMany.mockResolvedValue([scheduleDueIn(3)])
      await run()
      const morning = h.sendMessage.mock.calls[0][0].idempotencyKey

      expect(midnight).toContain("2026-08-20")
      expect(morning).toBe(midnight)
    } finally {
      vi.useRealTimers()
    }
  })

  it("still sends EMAIL when the WhatsApp template is missing, and reports failure", async () => {
    h.templateFindFirst.mockResolvedValue(null)

    const res = await run()

    // Loud: a non-2xx is what distinguishes this run from a clean one in the
    // scheduler log. (In-process cron — callCron() logs the failure and moves
    // on; there is no systemd unit to go red. See the note on the return.)
    expect(res.status).toBe(500)
    // ...but degraded, not total. Email has nothing to do with a WABA template
    // gap; aborting the run would cost the borrower the reminder they would
    // otherwise have received.
    expect(h.sendEmail).toHaveBeenCalledOnce()
    // Never a silent fallback to the free-text sender that cannot reach an
    // out-of-window borrower anyway.
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.sendWhatsApp).not.toHaveBeenCalled()
  })

  it("disables only the WhatsApp leg when the template claims statutoryOverride", async () => {
    h.templateFindFirst.mockResolvedValue({ ...TEMPLATE, statutoryOverride: true })

    const res = await run()

    expect(res.status).toBe(500)
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.sendEmail).toHaveBeenCalledOnce()
  })

  it("records a consent block as suppressed, never as 'may have been delivered'", async () => {
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "No email on file" },
      WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    h.sendMessage.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    const res = await run()
    const body = await res.json()

    // A deliberate refusal is a DEFINITE outcome. Filing it as ambiguous would
    // write a LoanNote claiming the message may have reached a borrower we
    // chose not to message — a false line in the record an auditor reads.
    expect(body.needsReconciliation).toBe(0)
    const note = h.noteCreate.mock.calls[0]?.[0]?.data?.note ?? ""
    expect(note).toContain("suppressed")
    expect(note).not.toContain("AMBIGUOUS")
  })

  it("does not count a QUEUED send as delivered", async () => {
    // WhatsApp-only, so the email leg cannot mask the outcome under test.
    h.availability.mockResolvedValue({
      EMAIL: { enabled: false, reason: "No email on file" },
      WHATSAPP: { enabled: true, toValue: "27820000000@s.whatsapp.net" },
      SMS: { enabled: false, reason: "SMS not enabled" },
    })
    h.sendMessage.mockResolvedValue({ status: "QUEUED", id: "m-wa-2" })

    const res = await run()
    const body = await res.json()

    // QUEUED is neither delivery nor definite rejection. Counting it as sent
    // would write the marker and retire a reminder that never arrived; calling
    // it a definite failure would replay a send the provider may yet accept.
    expect(body.sent).toBe(0)
    expect(body.needsReconciliation).toBe(1)
  })

  it("leaves the legacy free-text path untouched when the flag is off", async () => {
    delete process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS

    await run()

    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.templateFindFirst).not.toHaveBeenCalled()
    expect(h.sendWhatsApp).toHaveBeenCalled()
  })
})

// Default charges: the
// amount quoted is the instalment still owed PLUS the default charges
// outstanding. 0 while the tenant's flag is off, so the copy is unchanged.
describe("payment-reminders — default charges in the amount due", () => {
  const TEMPLATE = {
    id: "tpl-pd3",
    tenantId: "t1",
    key: "payment_due_3d_whatsapp",
    channel: "WHATSAPP",
    active: true,
    statutoryOverride: false,
    bodyTemplate: "Hi {{firstName}}, *{{amount}}* due *{{dueDate}}*. Ref *{{reference}}*.",
  }

  beforeEach(() => {
    h.findMany.mockResolvedValue([{ ...scheduleDueIn(3), totalPaid: 20_000 }])
  })

  it("asks for the charges owed now, for this loan, in this tenant", async () => {
    await run()
    expect(h.charges).toHaveBeenCalledWith(expect.anything(), { tenantId: "t1", loanId: "l1" }, expect.any(Date))
  })

  it("email and legacy WhatsApp quote the unpaid instalment + charges", async () => {
    h.charges.mockResolvedValue(12_345)
    await run()
    // 150_000 due − 20_000 paid + 12_345 charges
    expect(h.dueEmail.mock.calls[0][0]).toMatchObject({ tradingName: "Acme Lending" })
    expect(h.dueEmail.mock.calls[0][2]).toBe(142_345)
    expect(h.waDue3d.mock.calls[0][1]).toBe("R\u00a01\u00a0423,45")
  })

  it("WABA template path: {{amount}} is the charge-inclusive amount", async () => {
    process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS = "true"
    h.templateFindFirst.mockResolvedValue(TEMPLATE)
    h.sendMessage.mockResolvedValue({ status: "SENT", id: "m-wa-1" })
    h.charges.mockResolvedValue(12_345)
    await run()
    expect(h.sendMessage.mock.calls[0][0].vars.amount).toBe("R\u00a01\u00a0423,45")
  })

  it("flag off (charges 0): the amount is unchanged", async () => {
    await run()
    expect(h.dueEmail.mock.calls[0][2]).toBe(130_000)
    expect(h.waDue3d.mock.calls[0][1]).toBe("R\u00a01\u00a0300,00")
  })
})

describe("payment-reminders — never quotes R 0.00", () => {
  it("sends nothing for a row stored PARTIAL that is already covered", async () => {
    h.findMany.mockResolvedValue([{ ...scheduleDueIn(3), totalPaid: 150000 }])
    const body = await (await run()).json()
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.sendWhatsAppBridge).not.toHaveBeenCalled()
    expect(h.noteCreate).not.toHaveBeenCalled()
    expect(body.due).toBe(0)
  })
})
