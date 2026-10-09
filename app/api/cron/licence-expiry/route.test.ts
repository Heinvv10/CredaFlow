import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The licence-expiry job is invoked daily. Before the escalation bands existed
 * it created a NotificationLog and an AuditLog row on EVERY run for EVERY
 * adviser inside the 60-day window — roughly 60 duplicate "alerts" per licence
 * written into a regulated audit trail. These tests pin the properties that
 * make a recurring job safe: it alerts once per band per licence term, a
 * re-run changes nothing, and a partial write leaves no marker behind.
 *
 * TIME IS FROZEN for all of them. `daysRemaining` is a Math.floor over the gap
 * between the record's expiry and the handler's own `new Date()`. Building the
 * fixture with a live clock makes that gap 45 days minus however many
 * milliseconds elapsed before the handler ran — so the value is 45 when the
 * two calls land in the same millisecond and 44 otherwise. An earlier version
 * of this file asserted 45 and passed four runs in a row on that coincidence;
 * blind review reproduced the failure. A test whose truth depends on
 * scheduling is not evidence of anything.
 *
 * Mocked Prisma cannot see database constraints — the guard being tested here
 * is in application code, which is where a unit test can reach it.
 */

const NOW = new Date("2026-08-01T09:00:00.000Z")

const prismaMock = {
  fitAndProper: { findMany: vi.fn() },
  auditLog: { findFirst: vi.fn(), create: vi.fn() },
  notification: { create: vi.fn() },
  notificationLog: { create: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: vi.fn(async () => "tenant-1") }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn(() => null) }))

const { GET, alertBandFor, calendarDaysUntil, startOfSastDay } = await import("./route")

/** Exactly `days` * 24h after the frozen clock — no floor ambiguity. */
function expiryIn(days: number) {
  return new Date(NOW.getTime() + days * 86_400_000)
}

function adviser(id: string, expiresInDays: number) {
  return {
    id,
    userId: `user-${id}`,
    licenceNumber: `FSP-${id}`,
    licenceExpiry: expiryIn(expiresInDays),
    user: { id: `user-${id}`, name: "Adviser", email: "adviser@example.com", tenantId: "tenant-1" },
  }
}

const req = {} as never

/** The options object the route passed to $transaction. */
let txOptions: unknown

/** What the handler passed to auditLog.create, via the $transaction array. */
function auditPayload() {
  return prismaMock.auditLog.create.mock.calls[0]?.[0]?.data
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  prismaMock.auditLog.findFirst.mockResolvedValue(null)
  prismaMock.auditLog.create.mockImplementation((args: unknown) => args)
  prismaMock.notification.create.mockImplementation((args: unknown) => args)
  prismaMock.notificationLog.create.mockImplementation((args: unknown) => args)
  // Interactive transaction: run the callback against the same mock client so
  // the marker check and the three writes are exercised, and record the
  // isolation level the route asked for.
  prismaMock.$transaction.mockImplementation(async (fn: unknown, opts: unknown) => {
    txOptions = opts
    return (fn as (tx: typeof prismaMock) => Promise<boolean>)(prismaMock)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("alertBandFor", () => {
  it("returns the tightest band the remaining days have reached", () => {
    expect(alertBandFor(59)).toBe(60)
    expect(alertBandFor(31)).toBe(60)
    expect(alertBandFor(30)).toBe(30)
    expect(alertBandFor(20)).toBe(30)
    expect(alertBandFor(14)).toBe(14)
    expect(alertBandFor(8)).toBe(14)
    expect(alertBandFor(7)).toBe(7)
    expect(alertBandFor(2)).toBe(7)
    expect(alertBandFor(1)).toBe(1)
    expect(alertBandFor(0)).toBe(1)
  })

  it("returns null outside the alerting window", () => {
    // Above 60 days there is nothing to warn about yet. If this returned a
    // band, every adviser would be alerted the moment their record was created.
    expect(alertBandFor(61)).toBeNull()
    expect(alertBandFor(365)).toBeNull()
  })
})

describe("calendarDaysUntil", () => {
  // The job runs at 05:15 SAST; licence dates entered through the settings
  // form are stored at midnight. An elapsed-milliseconds floor answers these
  // one day short, which would put "expires in 0 day(s)" in a compliance
  // alert on the day BEFORE the licence expires.
  const at0515Sast = (isoDate: string) => new Date(`${isoDate}T03:15:00.000Z`)
  const midnightSast = (isoDate: string) => new Date(`${isoDate}T00:00:00.000+02:00`)

  it("counts calendar days, not elapsed hours", () => {
    expect(calendarDaysUntil(midnightSast("2026-08-02"), at0515Sast("2026-08-01"))).toBe(1)
    expect(calendarDaysUntil(midnightSast("2026-08-01"), at0515Sast("2026-08-01"))).toBe(0)
    expect(calendarDaysUntil(midnightSast("2026-08-31"), at0515Sast("2026-08-01"))).toBe(30)
  })

  it("counts in SAST, not UTC", () => {
    // 22:30 UTC on 1 Aug is already 00:30 on 2 Aug in SAST. Counting in UTC
    // would make this 1 day; in the business timezone it is the same day.
    const lateUtc = new Date("2026-08-01T22:30:00.000Z")
    expect(calendarDaysUntil(midnightSast("2026-08-02"), lateUtc)).toBe(0)
  })
})

describe("licence-expiry cron", () => {
  it("alerts once for an adviser inside a band", async () => {
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 45)])

    const res = await GET(req)

    expect(await res.json()).toMatchObject({ ok: true, processed: 1, alerted: 1, skipped: 0 })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(auditPayload().newValue).toMatchObject({ thresholdDays: 60, daysRemaining: 45 })
  })

  it("writes NOTHING on a second run in the same band", async () => {
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 45)])
    // Second run: the marker from the first run is on file.
    prismaMock.auditLog.findFirst.mockResolvedValue({ id: "audit-1" })

    const res = await GET(req)

    expect(await res.json()).toMatchObject({ ok: true, processed: 1, alerted: 0, skipped: 1 })
    // The transaction opens — that is where the marker is now read — but it
    // must write nothing and roll back to a no-op.
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled()
    expect(prismaMock.notification.create).not.toHaveBeenCalled()
    expect(prismaMock.notificationLog.create).not.toHaveBeenCalled()
  })

  it("looks the marker up by band AND licence term, not by record alone", async () => {
    // By record alone: one alert, then silence for the rest of the window —
    // the 7-day and 1-day escalations would never be sent.
    // Without the term: once a band has fired, every FUTURE licence term finds
    // the old row and is suppressed forever, because renewing updates the
    // existing FitAndProper row rather than creating a new one.
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 5)])

    await GET(req)

    expect(prismaMock.auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityId: "a",
          action: "LICENCE_EXPIRY_ALERT",
          AND: [
            { newValue: { path: ["thresholdDays"], equals: 7 } },
            { newValue: { path: ["licenceTerm"], equals: expiryIn(5).toISOString() } },
          ],
        }),
      }),
    )
  })

  it("alerts again at the same band after the licence is renewed", async () => {
    // The renewed term is a different licenceTerm, so its marker lookup misses
    // the previous term's row and the adviser is warned again.
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 30)])
    prismaMock.auditLog.findFirst.mockImplementation(async (args: never) => {
      const conds = (args as { where: { AND: { newValue: { equals: unknown } }[] } }).where.AND
      const term = conds[1].newValue.equals
      // A marker exists only for the PREVIOUS term.
      return term === expiryIn(-300).toISOString() ? { id: "old-audit" } : null
    })

    const res = await GET(req)

    expect(await res.json()).toMatchObject({ alerted: 1, skipped: 0 })
    expect(auditPayload().newValue).toMatchObject({ licenceTerm: expiryIn(30).toISOString() })
  })

  it("writes the marker, the bell item and the log in ONE transaction", async () => {
    // Separately, a committed marker plus a failed notification would suppress
    // the band forever and the adviser would never be told.
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 10)])

    await GET(req)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.notificationLog.create).toHaveBeenCalledTimes(1)
  })

  it("claims the marker at SERIALIZABLE isolation", async () => {
    // The marker is a read-then-write with no uniqueness constraint behind it.
    // At a weaker isolation level two overlapping invocations both read "no
    // marker" and both alert; Serializable is the only thing enforcing the
    // once-per-band claim.
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 10)])

    await GET(req)

    expect(txOptions).toMatchObject({ isolationLevel: "Serializable" })
  })

  it("reads the marker INSIDE the transaction, not before it", async () => {
    // Checking outside is what makes the race possible in the first place.
    const order: string[] = []
    prismaMock.$transaction.mockImplementation(async (fn: unknown, opts: unknown) => {
      txOptions = opts
      order.push("tx-open")
      return (fn as (tx: typeof prismaMock) => Promise<boolean>)(prismaMock)
    })
    prismaMock.auditLog.findFirst.mockImplementation(async () => {
      order.push("marker-read")
      return null
    })
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 10)])

    await GET(req)

    expect(order).toEqual(["tx-open", "marker-read"])
  })

  it("raises a bell item addressed to the licence holder", async () => {
    // An AuditLog row and a recipient-less NotificationLog row are not an
    // alert. Without this, the job reports `alerted` and nobody is told.
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 10)])

    await GET(req)

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.notification.create.mock.calls[0][0].data).toMatchObject({
      userId: "user-a",
      tenantId: "tenant-1",
      type: "LICENCE_EXPIRY",
      entityType: "FitAndProper",
      entityId: "a",
    })
    expect(prismaMock.notification.create.mock.calls[0][0].data.title).toContain("10 day(s)")
  })

  it("leaves no marker when the transaction fails, so the next run retries", async () => {
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 10)])
    prismaMock.$transaction.mockRejectedValue(new Error("could not serialize access"))

    const res = await GET(req)

    // The run itself still processes every OTHER adviser — one failing must
    // not abort the rest — but nothing is counted as alerted, and the run is
    // reported as failed so a persistently-broken write doesn't hide behind
    // "it'll retry tomorrow" forever.
    const json = await res.json()
    expect(json).toMatchObject({ ok: false, processed: 1, alerted: 0, failed: 1 })
    expect(res.status).toBe(503)
  })

  // The systemd wrapper calls this route with `curl -fsS`, which only fails
  // the unit on HTTP >= 400 and never parses the JSON body — so ok:false in
  // the body alone would still leave the unit green.
  it("reports 503 (not just ok:false) when a licence alert write fails", async () => {
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 10), adviser("b", 5)])
    prismaMock.$transaction
      .mockImplementationOnce(async (fn: unknown, opts: unknown) => {
        txOptions = opts
        return (fn as (tx: typeof prismaMock) => Promise<boolean>)(prismaMock)
      })
      .mockRejectedValueOnce(new Error("could not serialize access"))

    const res = await GET(req)

    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.alerted).toBe(1)
    expect(json.failed).toBe(1)
  })

  it("reports ok:true and 200 when there is nothing to alert (empty sweep)", async () => {
    prismaMock.fitAndProper.findMany.mockResolvedValue([])

    const res = await GET(req)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ ok: true, processed: 0, alerted: 0, failed: 0 })
  })

  it("includes licences expiring TODAY, so the 1-day band can fire", async () => {
    // Licence dates come from input[type=date] and are stored at midnight. A
    // `gte: now` bound on an 05:15 run has already excluded everything
    // expiring today, which makes alertBandFor(0) -> band 1 dead code and
    // removes the recovery path for a missed run.
    prismaMock.fitAndProper.findMany.mockResolvedValue([])

    await GET(req)

    const where = prismaMock.fitAndProper.findMany.mock.calls[0][0].where
    expect(where.licenceExpiry.gte).toEqual(startOfSastDay(NOW))
    expect(where.licenceExpiry.gte.getTime()).toBeLessThan(NOW.getTime())
  })

  it("alerts at the 1-day band for a licence expiring today", async () => {
    // The end-to-end version of the bound above: a licence expiring at
    // midnight today must still produce its final warning.
    const expiringToday = adviser("a", 0)
    expiringToday.licenceExpiry = startOfSastDay(NOW)
    prismaMock.fitAndProper.findMany.mockResolvedValue([expiringToday])

    const res = await GET(req)

    expect(await res.json()).toMatchObject({ alerted: 1 })
    expect(auditPayload().newValue).toMatchObject({ thresholdDays: 1, daysRemaining: 0 })
  })

  it("only considers advisers whose staff account is active", async () => {
    // A deactivated account cannot sign in to read the bell item, but alerting
    // it still burns the band's marker — so reactivating that adviser inside
    // the same band and term would leave them permanently unwarned.
    prismaMock.fitAndProper.findMany.mockResolvedValue([])

    await GET(req)

    expect(prismaMock.fitAndProper.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ user: { active: true } }),
      }),
    )
  })

  it("counts an adviser as processed but does not alert outside every band", async () => {
    // findMany already filters to <= 60 days, but the band check is the thing
    // that decides, and it must not fire on a record the query let through.
    prismaMock.fitAndProper.findMany.mockResolvedValue([adviser("a", 120)])

    const res = await GET(req)

    expect(await res.json()).toMatchObject({ processed: 1, alerted: 0 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
