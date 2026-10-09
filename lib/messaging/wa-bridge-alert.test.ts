import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: vi.fn() } } }))
vi.mock("@/lib/email/service", () => ({ sendEmail: vi.fn() }))

import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { decideWaBridgeAlert, sendWaBridgeAlert } from "./wa-bridge-alert"
import type { WaBridgeSlot } from "@/lib/whatsapp-bridge-admin"

function slot(overrides: Partial<WaBridgeSlot> = {}): WaBridgeSlot {
  return { slotId: "a", status: "CONNECTED", priority: 0, number: "1", connectedAt: null, disconnectedAt: null, lastDisconnectReason: null, ...overrides }
}

describe("decideWaBridgeAlert", () => {
  it("returns null when nothing dropped", () => {
    expect(decideWaBridgeAlert([{ slotId: "a", status: "CONNECTED" }], [slot()])).toBeNull()
  })

  it("returns WARNING when one slot drops but another stays connected", () => {
    const decision = decideWaBridgeAlert(
      [{ slotId: "a", status: "CONNECTED" }, { slotId: "b", status: "CONNECTED" }],
      [
        slot({ slotId: "a", status: "DISCONNECTED", number: "1", lastDisconnectReason: "LOGGED_OUT" }),
        slot({ slotId: "b", status: "CONNECTED", priority: 1, number: "2" }),
      ],
    )
    expect(decision?.severity).toBe("WARNING")
    expect(decision?.message).toContain("2")
  })

  // The case above leaves exactly ONE slot connected, and a single-element
  // reduce returns that element whatever the comparator says — so it cannot
  // tell "lowest priority wins" from "highest priority wins". Traffic actually
  // fails over to the LOWEST priority (selectActiveSlot in the bridge uses the
  // same rule), so naming the wrong number here would send admins chasing a
  // number that is not carrying the traffic.
  it("names the lowest-priority survivor when several slots stay connected", () => {
    const decision = decideWaBridgeAlert(
      [
        { slotId: "a", status: "CONNECTED" },
        { slotId: "b", status: "CONNECTED" },
        { slotId: "c", status: "CONNECTED" },
      ],
      [
        slot({ slotId: "a", status: "DISCONNECTED", priority: 0, number: "27820000001" }),
        slot({ slotId: "b", status: "CONNECTED", priority: 7, number: "27820000007" }),
        slot({ slotId: "c", status: "CONNECTED", priority: 3, number: "27820000003" }),
      ],
    )
    expect(decision?.severity).toBe("WARNING")
    expect(decision?.message).toContain("27820000003")
    expect(decision?.message).not.toContain("27820000007")
  })

  it("returns CRITICAL when the last connected slot drops", () => {
    const decision = decideWaBridgeAlert(
      [{ slotId: "a", status: "CONNECTED" }],
      [slot({ slotId: "a", status: "LOGGED_OUT", lastDisconnectReason: "LOGGED_OUT" })],
    )
    expect(decision?.severity).toBe("CRITICAL")
  })

  it("ignores a slot that was already disconnected last poll", () => {
    expect(
      decideWaBridgeAlert([{ slotId: "a", status: "DISCONNECTED" }], [slot({ slotId: "a", status: "DISCONNECTED" })]),
    ).toBeNull()
  })

  // Pausing is how an operator parks a rate-limited or restricted number
  // without logging it out. Emailing every ADMIN a CRITICAL for that is how
  // outage alerts become noise people filter away — and this channel is the
  // ONLY alerting channel.
  it("does not alert when an admin deliberately pauses a number", () => {
    const decision = decideWaBridgeAlert(
      [{ slotId: "a", status: "CONNECTED" }, { slotId: "b", status: "CONNECTED" }],
      [
        slot({ slotId: "a", status: "PAUSED", priority: 0, number: "27780000001" }),
        slot({ slotId: "b", status: "CONNECTED", priority: 1, number: "27780000002" }),
      ],
    )
    expect(decision).toBeNull()
  })

  it("still alerts CRITICAL when a real drop happens alongside a paused slot", () => {
    const decision = decideWaBridgeAlert(
      [{ slotId: "a", status: "CONNECTED" }, { slotId: "b", status: "CONNECTED" }],
      [
        slot({ slotId: "a", status: "PAUSED", priority: 0, number: "27780000001" }),
        slot({ slotId: "b", status: "LOGGED_OUT", priority: 1, number: "27780000002", lastDisconnectReason: "LOGGED_OUT" }),
      ],
    )
    expect(decision?.severity).toBe("CRITICAL")
    // Only the genuine failure is named — a parked number is not an incident.
    expect(decision?.message).toContain("27780000002")
    expect(decision?.message).not.toContain("27780000001")
  })
})

describe("sendWaBridgeAlert", () => {
  beforeEach(() => vi.clearAllMocks())

  it("emails every active ADMIN/SUPER_ADMIN user for the tenant", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "a@x.com", name: "A" }, { email: "b@x.com", name: "B" }] as never)
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

    const sent = await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

    expect(sent).toBe(2)
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1", role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true }) }),
    )
  })

  it("skips users with no email and counts only successful sends", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: null, name: "No Email" }, { email: "b@x.com", name: "B" }] as never)
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

    const sent = await sendWaBridgeAlert("tenant-1", { severity: "WARNING", message: "x" })
    expect(sent).toBe(1)
  })

  // This email is read during an outage. It named "Comms Hub → WhatsApp Bridge",
  // a tab that no longer exists — an instruction that sends an admin looking for
  // a control on a page that does not have it.
  it("points admins at the page where the bridge tab actually is", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u1", email: "a@x.com", name: "A" }] as never)
    vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

    await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

    const html = String(vi.mocked(sendEmail).mock.calls[0][0].html)
    expect(html).toContain("Settings &rarr; WhatsApp &rarr; Bridge")
    expect(html).not.toContain("Comms Hub")
  })

  it("isolates a thrown send failure so later recipients still get emailed", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "a@x.com", name: "A" }, { email: "b@x.com", name: "B" }] as never)
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValueOnce({ ok: true } as never)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const sent = await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

    expect(sent).toBe(1)
    expect(sendEmail).toHaveBeenCalledTimes(2)
    errorSpy.mockRestore()
  })

  describe("WA_BRIDGE_ALERT_RECIPIENTS narrowing", () => {
    afterEach(() => vi.unstubAllEnvs())

    it("pages only the listed admin when the allowlist is set", async () => {
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", "staff@acme-lending.example")
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { email: "admin@acme-lending.example", name: "Admin" },
        { email: "officer.one@acme-lending.example", name: "Officer One" },
        { email: "staff@acme-lending.example", name: "Staff" },
        { email: "nora@acme-lending.example", name: "Nora" },
      ] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      const sent = await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

      expect(sent).toBe(1)
      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "staff@acme-lending.example" }))
    })

    it("accepts a multi-address list and ignores surrounding whitespace", async () => {
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", " staff@acme-lending.example , admin@acme-lending.example ")
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { email: "admin@acme-lending.example", name: "Admin" },
        { email: "officer.one@acme-lending.example", name: "Officer One" },
        { email: "staff@acme-lending.example", name: "Staff" },
      ] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      const sent = await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

      expect(sent).toBe(2)
      expect(vi.mocked(sendEmail).mock.calls.map((c) => (c[0] as { to: string }).to).sort()).toEqual([
        "admin@acme-lending.example",
        "staff@acme-lending.example",
      ])
    })

    // Addresses are compared case-insensitively on both sides. A User row
    // stored with different casing than the env entry is the same mailbox,
    // and matching it exactly would silently page nobody.
    it("matches case-insensitively on both the allowlist and the stored address", async () => {
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", "STAFF@ACME-LENDING.EXAMPLE")
      vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "Staff@Acme-Lending.example", name: "Staff" }] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      expect(await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })).toBe(1)
    })

    // The allowlist NARROWS the admin query, it does not replace it. An
    // address that is not an active ADMIN/SUPER_ADMIN of this tenant must not
    // receive infrastructure alerts just because it appears in an env var.
    it("does not page an address that is not an active admin", async () => {
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", "outsider@example.com")
      vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "staff@acme-lending.example", name: "Staff" }] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

      // The security property: an env var must never subscribe a non-admin.
      const addressed = vi.mocked(sendEmail).mock.calls.map((c) => (c[0] as { to: string }).to)
      expect(addressed).not.toContain("outsider@example.com")
    })

    // A narrowing filter that matches NOBODY is a misconfiguration, not an
    // instruction to page nobody. One mistyped character in an env var
    // otherwise silences the outage alert on a channel carrying NCA notices —
    // recreating the exact silent failure this monitor exists to catch. The
    // fallback is to the ADMIN LIST, never to the unmatched address, so the
    // knob still cannot widen the audience.
    it("falls back to every admin when the allowlist matches nobody", async () => {
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", "satff@acme-lending.example")   // typo for staff@
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { email: "staff@acme-lending.example", name: "Staff" },
        { email: "ops@acme-lending.example", name: "Ops" },
      ] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      const sent = await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

      expect(sent).toBe(2)
      const addressed = vi.mocked(sendEmail).mock.calls.map((c) => (c[0] as { to: string }).to)
      expect(addressed).toEqual(["staff@acme-lending.example", "ops@acme-lending.example"])
      // and never the typo itself
      expect(addressed).not.toContain("satff@acme-lending.example")
    })

    it("still narrows when the allowlist matches at least one admin", async () => {
      // The fallback must not swallow a legitimate narrowing.
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", "staff@acme-lending.example")
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { email: "staff@acme-lending.example", name: "Staff" },
        { email: "ops@acme-lending.example", name: "Ops" },
      ] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      const sent = await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })

      expect(sent).toBe(1)
      const addressed = vi.mocked(sendEmail).mock.calls.map((c) => (c[0] as { to: string }).to)
      expect(addressed).toEqual(["staff@acme-lending.example"])
    })

    it("pages every admin when the allowlist is unset", async () => {
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { email: "a@x.com", name: "A" },
        { email: "b@x.com", name: "B" },
      ] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      expect(await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })).toBe(2)
    })

    // An entry of only whitespace/commas is a misconfiguration, not an
    // instruction to page nobody. Treating it as "narrow to the empty set"
    // would turn a stray keystroke in .env into total alert silence.
    it("falls back to every admin when the allowlist is empty or whitespace", async () => {
      vi.stubEnv("WA_BRIDGE_ALERT_RECIPIENTS", " , , ")
      vi.mocked(prisma.user.findMany).mockResolvedValue([
        { email: "a@x.com", name: "A" },
        { email: "b@x.com", name: "B" },
      ] as never)
      vi.mocked(sendEmail).mockResolvedValue({ ok: true } as never)

      expect(await sendWaBridgeAlert("tenant-1", { severity: "CRITICAL", message: "down" })).toBe(2)
    })
  })
})
