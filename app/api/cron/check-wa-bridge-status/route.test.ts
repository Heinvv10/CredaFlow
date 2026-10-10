import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    waBridgeNumber: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    waBridgeAlarm: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    commsSettings: { findUnique: vi.fn() },
  },
}))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>()
  return { ...actual, logAudit: vi.fn() }
})
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: vi.fn() }))
vi.mock("@/lib/whatsapp-bridge-admin", () => ({ listWaBridgeNumbers: vi.fn() }))
vi.mock("@/lib/messaging/wa-bridge-alert", () => ({ decideWaBridgeAlert: vi.fn(), sendWaBridgeAlert: vi.fn() }))

import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { logAudit } from "@/lib/audit"
import { getTenantFromRequest } from "@/lib/tenant"
import { listWaBridgeNumbers } from "@/lib/whatsapp-bridge-admin"
import { decideWaBridgeAlert, sendWaBridgeAlert } from "@/lib/messaging/wa-bridge-alert"
import { GET } from "./route"

const req = new NextRequest("http://x/api/cron/check-wa-bridge-status")

describe("GET /api/cron/check-wa-bridge-status", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Every existing test in this file exercises the "bridge IS configured"
    // path, so WA_SENDER_URL is stubbed present by default here. The
    // [CRON-SKIP] tests below override it per-test to exercise the
    // not-configured branch.
    vi.stubEnv("WA_SENDER_URL", "http://bridge.test")
    vi.stubEnv("WA_ENABLED", "true")
    vi.mocked(verifyCronSecret).mockReturnValue(null)
    vi.mocked(getTenantFromRequest).mockResolvedValue({ id: "tenant-1" } as never)
    vi.mocked(prisma.waBridgeNumber.findMany).mockResolvedValue([])
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    // WA_UNOFFICIAL by default so every pre-existing test in this file keeps
    // exercising the bridge-monitoring path it was written for. Defaulting
    // this to WA_CLOUD (or leaving it undefined-by-omission) would send them
    // all down the new skip branch and pass vacuously.
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_UNOFFICIAL" } as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // The in-process scheduler runs this cron in EVERY environment, and
  // listWaBridgeNumbers() throws when WA_SENDER_URL is unset. Without this
  // early check, any environment that simply hasn't been given a bridge yet
  // would fall into the "bridge unreachable" catch below and email ADMINs a
  // false CRITICAL. An environment with WhatsApp switched OFF must be silent
  // and untracked -- distinct from a bridge that IS configured but genuinely
  // unreachable, which still has to alert (covered by the 502 tests above).
  it("[CRON-SKIP] skips cleanly when WhatsApp is disabled: no alert, no DB write", async () => {
    vi.stubEnv("WA_ENABLED", "false")

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, skipped: "wa_disabled" })
    expect(listWaBridgeNumbers).not.toHaveBeenCalled()
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(prisma.waBridgeNumber.findMany).not.toHaveBeenCalled()
    expect(prisma.waBridgeNumber.upsert).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.findUnique).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
  })

  it("[CLOUD-SKIP] skips cleanly when the tenant is on the Cloud API", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, skipped: "wa_cloud" })
    expect(listWaBridgeNumbers).not.toHaveBeenCalled()
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(prisma.waBridgeNumber.findMany).not.toHaveBeenCalled()
    expect(prisma.waBridgeNumber.upsert).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.findUnique).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
  })

  // A deployment on WA_CLOUD with WA_BRIDGE_ADMIN_SECRET unset in the app
  // container: listWaBridgeNumbers() throws before making any network call
  // and the catch below would report "bridge unreachable" -- a CRITICAL every
  // 6h to every admin about a bridge that nothing sends through. Reproduce
  // both conditions together, not just the provider, because the throw is
  // what reaches the alert path.
  it("[CLOUD-SKIP] does not alert when the bridge is unreadable AND the tenant is on Cloud API", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("WA_BRIDGE_ADMIN_SECRET is not configured"))

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, skipped: "wa_cloud" })
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
  })

  // Fail toward monitoring, not toward silence. A tenant with no CommsSettings
  // row has not been moved to the Cloud API -- resolveProvider() falls back to
  // WA_UNOFFICIAL for exactly this shape (lib/messaging/send.ts), so the
  // bridge IS still the delivery path and a real outage must still page.
  it("[CLOUD-SKIP] still monitors when the tenant has no CommsSettings row", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue(null)
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("bridge down"))
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    const res = await GET(req)

    expect(res.status).toBe(502)
    expect(listWaBridgeNumbers).toHaveBeenCalled()
    expect(sendWaBridgeAlert).toHaveBeenCalledTimes(1)
  })

  // The guard must not swallow a genuine bridge outage for a tenant that has
  // NOT migrated. Without this, narrowing the condition to "skip whenever a
  // CommsSettings row exists" would still pass every test above.
  it("[CLOUD-SKIP] still alerts on a real outage while the tenant is on WA_UNOFFICIAL", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_UNOFFICIAL" } as never)
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("bridge down"))
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    const res = await GET(req)

    expect(res.status).toBe(502)
    expect(sendWaBridgeAlert).toHaveBeenCalledTimes(1)
  })

  // WhatsApp ENABLED with no bridge URL is not
  // the benign "not provisioned" case. lib/whatsapp.ts's getWaSenderUrl()
  // falls back to a hardcoded third-party host, so customer messages --
  // including NCA Section 129 notices -- could be flowing through a bridge
  // this monitor cannot see while it reports ok:true. Monitoring nothing and
  // claiming healthy is the precise failure this feature exists to kill.
  it("[MISCONFIGURED] alerts when WhatsApp is enabled but WA_SENDER_URL is missing", async () => {
    vi.stubEnv("WA_SENDER_URL", "")
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(2)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(2)
    expect(sendWaBridgeAlert).toHaveBeenCalled()
    // It must not pretend to have polled a bridge it never had an address for.
    expect(listWaBridgeNumbers).not.toHaveBeenCalled()
    expect(prisma.waBridgeNumber.upsert).not.toHaveBeenCalled()
  })

  // Email is the ONLY alerting channel (there is no dashboard banner). If every ADMIN is undeliverable -- none exists, none
  // has an email, EmailConfig is inactive, or the allowlist blocks every
  // address -- sendWaBridgeAlert returns 0, the alarm correctly does NOT latch,
  // and the cron retries forever with nobody ever told. Not latching is right;
  // having no record of it is the silent outage all over again.
  it("[UNDELIVERABLE] records an audit row when an outage alert reaches ZERO recipients", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue({ severity: "CRITICAL", message: "down" })
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(0)

    const body = await (await GET(req)).json()

    expect(body.alerted).toBe(0)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "WA_BRIDGE_ALERT_UNDELIVERABLE",
        tenantId: "tenant-1",
        newValue: expect.objectContaining({ severity: "CRITICAL" }),
      }),
    )
    // Still must not latch — the next poll has to retry.
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
  })

  it("[UNDELIVERABLE] writes no such audit row when the alert was delivered", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue({ severity: "CRITICAL", message: "down" })
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    await GET(req)

    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "WA_BRIDGE_ALERT_UNDELIVERABLE" }),
    )
  })

  // The upserts only ever ADD, so retired slots would linger in the mirror
  // forever. `previous` feeds decideWaBridgeAlert, so a stale CONNECTED row would eventually manufacture
  // a phantom disconnect for a number that no longer exists.
  it("[MIRROR] deletes rows for slots the bridge no longer reports", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "live", number: "1", status: "CONNECTED", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: null },
    ] as never)

    await GET(req)

    expect(prisma.waBridgeNumber.deleteMany).toHaveBeenCalledWith({
      where: { slotId: { notIn: ["live"] } },
    })
  })

  it("[MIRROR] never prunes on the unreachable-bridge path — we cannot write state we could not read", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))

    await GET(req)

    expect(prisma.waBridgeNumber.deleteMany).not.toHaveBeenCalled()
  })

  it("401s when the cron secret is wrong", async () => {
    const denied = new Response(null, { status: 401 })
    vi.mocked(verifyCronSecret).mockReturnValue(denied as never)
    const res = await GET(req)
    expect(res.status).toBe(401)
  })

  it("upserts every polled slot and skips alerting when nothing dropped", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "CONNECTED", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: null },
    ] as never)

    const res = await GET(req)
    const body = await res.json()

    expect(prisma.waBridgeNumber.upsert).toHaveBeenCalledTimes(1)
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(body.alert).toBeNull()
  })

  it("alerts when a disconnect is detected", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue({ severity: "CRITICAL", message: "down" })
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(2)

    const res = await GET(req)
    const body = await res.json()

    expect(sendWaBridgeAlert).toHaveBeenCalledWith("tenant-1", { severity: "CRITICAL", message: "down" })
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(2)
  })

  it("returns 502 when the bridge is unreachable and never upserts a slot it couldn't read", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    const res = await GET(req)
    expect(res.status).toBe(502)
    expect(prisma.waBridgeNumber.upsert).not.toHaveBeenCalled()
  })

  // --- The bridge container itself being unreachable (crashed,
  // network-partitioned, bad WA_SENDER_URL) is a silent outage of its own --
  // every poll 502s and nobody would be alerted. Gated by
  // the SAME WaBridgeAlarm flag as the "logged out" case so it can't storm.

  it("[BRIDGE-UNREACHABLE 1] fires CRITICAL once when the bridge itself is unreachable and no alarm is active, still 502s", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(2)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(sendWaBridgeAlert).toHaveBeenCalledWith("tenant-1", {
      severity: "CRITICAL",
      message: "The WhatsApp bridge could not be reached or its status could not be read (this may be a connectivity, credential, or version problem). Outbound WhatsApp may be affected.",
    })
    expect(prisma.waBridgeAlarm.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { id: "singleton", active: true, lastAlertedAt: expect.any(Date) },
      update: { active: true, lastAlertedAt: expect.any(Date) },
    })
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(2)
  })

  it("[BRIDGE-UNREACHABLE 2] does not re-alert when the bridge is unreachable and an alarm is already active, still 502s", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue({
      id: "singleton", active: true, lastAlertedAt: new Date(), updatedAt: new Date(),
    } as never)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
    expect(body.alert).toBeNull()
    expect(body.alerted).toBe(0)
  })

  it("[BRIDGE-UNREACHABLE 3] never upserts WaBridgeNumber when the bridge is unreachable, alarm or not", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    await GET(req)

    expect(prisma.waBridgeNumber.upsert).not.toHaveBeenCalled()
  })

  // --- Edge cases ---

  // An empty slot pool is reachable through the
  // feature's own UI (Retire on the last remaining number) and is a total
  // outbound outage, not a "nothing to report" state. `current.length > 0 &&`
  // would suppress this on the theory it was only a cold-start window, but
  // that window is microseconds (registerSlot is synchronous inside boot's
  // loop) versus a 5-minute poll -- the trade would be backwards. The empty
  // pool must fire.
  it("fires the allDown fallback when the bridge reports zero slots (empty pool is an outage, not silence)", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([])
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(2)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(sendWaBridgeAlert).toHaveBeenCalledWith("tenant-1", {
      severity: "CRITICAL",
      message: "No WhatsApp number is connected. Outbound WhatsApp is down.",
    })
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(2)
  })

  it("does not re-alert an empty pool when the alarm is already active", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([])
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue({
      id: "singleton", active: true, lastAlertedAt: new Date(), updatedAt: new Date(),
    } as never)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(body.alert).toBeNull()
  })

  // The alarm latch must not reproduce the long silent outage it was built to
  // prevent. The alarm latches on the FIRST poll of an outage; from then on
  // `transition` is null (the mirror was updated), the all-down fallback is
  // gated on the alarm, and the clear branch needs a CONNECTED slot that by
  // definition does not exist while the channel is down. One email, ever.

  it("[RE-ALERT] re-alerts a still-unresolved outage once the re-alert interval has passed", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "27821111111", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null) // no transition: already down at the last poll
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue({
      id: "singleton",
      active: true,
      lastAlertedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h ago
      updatedAt: new Date(),
    } as never)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    const body = await (await GET(req)).json()

    expect(sendWaBridgeAlert).toHaveBeenCalled()
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(1)
  })

  it("[RE-ALERT] still suppresses a repeat alert inside the re-alert interval", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "27821111111", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue({
      id: "singleton",
      active: true,
      lastAlertedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
      updatedAt: new Date(),
    } as never)

    const body = await (await GET(req)).json()

    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(body.alert).toBeNull()
  })

  it("[RE-ALERT] re-alerts an unreachable bridge once the interval has passed", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("ECONNREFUSED"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue({
      id: "singleton",
      active: true,
      lastAlertedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      updatedAt: new Date(),
    } as never)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(sendWaBridgeAlert).toHaveBeenCalled()
    expect(body.alert).toBe("CRITICAL")
  })

  // A WARNING means traffic failed over and the channel is still UP. Latching
  // on it arms the suppression that gates the all-down and unreachable
  // branches, so a TOTAL outage minutes later goes unalerted indefinitely.
  it("[WARNING-NO-LATCH] a failover WARNING must not latch the alarm that gates CRITICAL", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "27821111111", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
      { slotId: "b", number: "27822222222", status: "CONNECTED", priority: 1, connectedAt: null, disconnectedAt: null, lastDisconnectReason: null },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue({
      severity: "WARNING",
      message: "WhatsApp number 27821111111 disconnected. Traffic has failed over to 27822222222.",
    })
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    const body = await (await GET(req)).json()

    expect(body.alert).toBe("WARNING")
    expect(body.alerted).toBe(1)
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
  })

  // A throw is not the only failure mode: sendWaBridgeAlert swallows
  // per-recipient failures and returns a COUNT -- it can resolve 0 without
  // throwing (EmailConfig missing/inactive, or every recipient blocked by the
  // allowlist guard; see lib/email/service.ts). If the alarm latched on a
  // 0-delivery run, `!alarm?.active` would suppress every later poll forever
  // with nobody ever notified -- the silent-outage shape this
  // branch exists to prevent. These tests prove BOTH call sites (the normal
  // path and the bridge-unreachable 502 path share fireCriticalAlarm).

  it("main path: does not latch the alarm when zero recipients were alerted, so the next poll retries", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(0)

    const res = await GET(req)
    const body = await res.json()

    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(0)

    // Next poll: the alarm row is still not active (findUnique keeps
    // resolving null, exactly as an un-upserted singleton would), so the
    // outage must fire again rather than being permanently suppressed.
    const res2 = await GET(req)
    const body2 = await res2.json()
    expect(sendWaBridgeAlert).toHaveBeenCalledTimes(2)
    expect(body2.alert).toBe("CRITICAL")
  })

  it("main path: DOES latch the alarm when at least one recipient was alerted (existing behaviour preserved)", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    await GET(req)

    expect(prisma.waBridgeAlarm.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { id: "singleton", active: true, lastAlertedAt: expect.any(Date) },
      update: { active: true, lastAlertedAt: expect.any(Date) },
    })
  })

  it("bridge-unreachable path: does not latch the alarm when zero recipients were alerted, so the next poll retries", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(0)

    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
    expect(body.alerted).toBe(0)

    const res2 = await GET(req)
    expect(sendWaBridgeAlert).toHaveBeenCalledTimes(2)
    expect(res2.status).toBe(502)
  })

  it("bridge-unreachable path: DOES latch the alarm when at least one recipient was alerted (existing behaviour preserved)", async () => {
    vi.mocked(listWaBridgeNumbers).mockRejectedValue(new Error("fetch failed"))
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(1)

    await GET(req)

    expect(prisma.waBridgeAlarm.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { id: "singleton", active: true, lastAlertedAt: expect.any(Date) },
      update: { active: true, lastAlertedAt: expect.any(Date) },
    })
  })

  it("does not mark the alarm active when sendWaBridgeAlert itself throws", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockRejectedValue(new Error("email service down"))

    await expect(GET(req)).rejects.toThrow("email service down")
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
  })

  // --- Cold-start / stuck-down alarm tests ---
  // decideWaBridgeAlert is a two-snapshot diff and cannot see a system that
  // was ALREADY broken when polling started. These three tests prove the
  // independent WaBridgeAlarm singleton closes that hole: a bridge that is
  // down for days must not go without an alert.

  it("[MANDATORY 1] cold start: bridge already down, no alarm row yet -> fires CRITICAL", async () => {
    // previous is empty (first poll ever / after deploy) and every current
    // slot is LOGGED_OUT -- decideWaBridgeAlert sees no CONNECTED->bad
    // transition (nothing to diff against) and correctly returns null.
    vi.mocked(prisma.waBridgeNumber.findMany).mockResolvedValue([])
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue(null)
    vi.mocked(sendWaBridgeAlert).mockResolvedValue(3)

    const res = await GET(req)
    const body = await res.json()

    expect(sendWaBridgeAlert).toHaveBeenCalledWith("tenant-1", {
      severity: "CRITICAL",
      message: "No WhatsApp number is connected. Outbound WhatsApp is down.",
    })
    expect(prisma.waBridgeAlarm.upsert).toHaveBeenCalledWith({
      where: { id: "singleton" },
      create: { id: "singleton", active: true, lastAlertedAt: expect.any(Date) },
      update: { active: true, lastAlertedAt: expect.any(Date) },
    })
    expect(body.alert).toBe("CRITICAL")
    expect(body.alerted).toBe(3)
  })

  it("[MANDATORY 2] stuck down, alarm already active -> no second alert", async () => {
    vi.mocked(listWaBridgeNumbers).mockResolvedValue([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValue(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValue({
      id: "singleton", active: true, lastAlertedAt: new Date(), updatedAt: new Date(),
    } as never)

    const res = await GET(req)
    const body = await res.json()

    expect(sendWaBridgeAlert).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.upsert).not.toHaveBeenCalled()
    expect(prisma.waBridgeAlarm.updateMany).not.toHaveBeenCalled()
    expect(body.alert).toBeNull()
  })

  it("[MANDATORY 3] recovery clears the alarm, then a new outage fires CRITICAL again", async () => {
    // Poll 1: one slot recovers to CONNECTED while an alarm is on record.
    vi.mocked(listWaBridgeNumbers).mockResolvedValueOnce([
      { slotId: "a", number: "1", status: "CONNECTED", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: null },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValueOnce(null)
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValueOnce({
      id: "singleton", active: true, lastAlertedAt: new Date(), updatedAt: new Date(),
    } as never)

    await GET(req)

    expect(prisma.waBridgeAlarm.updateMany).toHaveBeenCalledWith({ where: { active: true }, data: { active: false } })
    expect(sendWaBridgeAlert).not.toHaveBeenCalled()

    // Poll 2: a fresh outage -- decideWaBridgeAlert now genuinely sees a
    // CONNECTED -> bad transition (it has "previously CONNECTED" state from
    // poll 1 to diff against, unlike the cold-start case).
    vi.mocked(listWaBridgeNumbers).mockResolvedValueOnce([
      { slotId: "a", number: "1", status: "LOGGED_OUT", priority: 0, connectedAt: null, disconnectedAt: null, lastDisconnectReason: "LOGGED_OUT" },
    ] as never)
    vi.mocked(decideWaBridgeAlert).mockReturnValueOnce({ severity: "CRITICAL", message: "All WhatsApp numbers are disconnected." })
    vi.mocked(prisma.waBridgeAlarm.findUnique).mockResolvedValueOnce({
      id: "singleton", active: false, lastAlertedAt: new Date(), updatedAt: new Date(),
    } as never)
    vi.mocked(sendWaBridgeAlert).mockResolvedValueOnce(2)

    const res2 = await GET(req)
    const body2 = await res2.json()

    expect(sendWaBridgeAlert).toHaveBeenCalledWith("tenant-1", { severity: "CRITICAL", message: "All WhatsApp numbers are disconnected." })
    expect(body2.alert).toBe("CRITICAL")
  })
})
