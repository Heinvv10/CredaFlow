import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  config: null as unknown,
  review: vi.fn(),
  lockOrder: [] as string[],
  logError: vi.fn(),
  tx: null as unknown,
}))

vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: (_t: string, fn: () => unknown) => fn(), withoutTenantScope: (fn: () => unknown) => fn() }))
vi.mock("@/lib/observability/logger", () => ({ logger: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("./digital-submission", () => ({ reviewDigitalSubmission: h.review }))
vi.mock("@/lib/prisma", () => {
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === "OR") { if (!(v as Array<Record<string, unknown>>).some((w) => match(row, w))) return false; continue }
      const have = row[k]
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as { lt?: Date; gte?: Date; in?: unknown[] }
        if (o.lt && !(have instanceof Date && have < o.lt)) return false
        if (o.gte && !(have instanceof Date && have >= o.gte)) return false
        if (o.in && !o.in.includes(have)) return false
      } else if (have !== v && !(v === null && have == null)) return false
    }
    return true
  }
  const prisma: Record<string, unknown> = {
      decisionEngineConfig: { findUnique: vi.fn(async () => h.config) },
      loanApplication: { findFirst: vi.fn(async () => ({ clientId: "c-from-app" })) },
      autoDecisionDue: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (h.rows.some((r) => r.tenantId === data.tenantId && r.applicationId === data.applicationId)) throw Object.assign(new Error("dup"), { code: "P2002" })
          h.rows.push({ id: `d${h.rows.length + 1}`, claimedAt: null, completedAt: null, outcome: null, attempts: 0, createdAt: new Date(), ...data })
          return {}
        }),
        findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => h.rows.filter((r) => match(r, where)).slice(0, take)),
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => h.rows.find((r) => match(r, where)) ?? null),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = h.rows.filter((r) => match(r, where))
          for (const r of hit) for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === "object" && "increment" in (v as object) ? Number(r[k]) + (v as { increment: number }).increment : v
          return { count: hit.length }
        }),
        deleteMany: vi.fn(async ({ where }: { where: { completedAt: { lt: Date } } }) => { const keep = h.rows.filter((r) => !(r.completedAt instanceof Date && r.completedAt < where.completedAt.lt)); const n = h.rows.length - keep.length; h.rows = keep; return { count: n } }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { Object.assign(h.rows.find((r) => r.id === where.id) as object, data); return {} }),
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => h.rows.filter((r) => match(r, where)).length),
      },
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => { h.lockOrder.push(key); return 1 }),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  }
  h.tx = prisma
  return { prisma }
})

import {
  markDigitalDecisionDue, runDigitalDue, sweepDigitalDecisions, DIGITAL_SWEEP_AFTER_MINUTES, DIGITAL_MAX_ATTEMPTS,
  DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, DIGITAL_REVIEWS_PER_IP_PER_DAY, DIGITAL_REVIEWS_UNKNOWN_IP_PER_DAY,
  admitDigitalReview, digitalReviewsPerLenderPerDay, ipBucket,
} from "./digital-due"

const NOW = new Date("2026-10-29T10:00:00Z")
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const live = { mode: "LIVE", channels: ["PORTAL"] }
const due = (over: Record<string, unknown> = {}) => ({ id: `d${h.rows.length + 1}`, tenantId: "t", applicationId: "a1", clientId: "c1", ip: "1.2.3.4", createdAt: minutesAgo(10), claimedAt: null, completedAt: null, outcome: null, attempts: 0, ...over })

beforeEach(() => { h.rows = []; h.config = live; h.review.mockReset().mockImplementation(async (a: { admit?: (tx: unknown) => Promise<boolean> }) => (a.admit && !(await a.admit(h.tx)) ? { status: "RATE_LIMITED" } : { status: "REVIEWED" })); h.lockOrder = [] })

describe("markDigitalDecisionDue", () => {
  it("writes the due row for a lender whose engine covers the portal", async () => {
    expect(await markDigitalDecisionDue({ tenantId: "t", applicationId: "a1", clientId: "c1", ip: "1.2.3.4" })).toBe(true)
    expect(h.rows).toHaveLength(1)
  })
  it.each([[null], [{ mode: "OFF", channels: ["PORTAL"] }], [{ mode: "LIVE", channels: ["STAFF"] }]])("writes nothing where the engine is off or does not cover the portal (%j)", async (config) => {
    h.config = config
    expect(await markDigitalDecisionDue({ tenantId: "t", applicationId: "a1", clientId: "c1", ip: null })).toBe(false)
    expect(h.rows).toHaveLength(0)
  })
  it("takes the client from the application when the route does not hold it (the website form)", async () => {
    await markDigitalDecisionDue({ tenantId: "t", applicationId: "a1", ip: null })
    expect(h.rows[0].clientId).toBe("c-from-app")
  })
  it("a second mark for the same application is not an error", async () => {
    await markDigitalDecisionDue({ tenantId: "t", applicationId: "a1", clientId: "c1", ip: null })
    await expect(markDigitalDecisionDue({ tenantId: "t", applicationId: "a1", clientId: "c1", ip: null })).resolves.toBe(true)
    expect(h.rows).toHaveLength(1)
  })
})

describe("runDigitalDue", () => {
  it("claims the row, reviews, and completes it with how it ended", async () => {
    h.rows.push(due({ createdAt: NOW }))
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.review).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t", applicationId: "a1" }))
    expect(h.rows[0]).toMatchObject({ outcome: "REVIEWED", attempts: 1 })
    expect(h.rows[0].completedAt).not.toBeNull()
  })

  it("does not run a row another worker holds, or one already complete", async () => {
    h.rows.push(due({ claimedAt: minutesAgo(1) }))
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    h.rows[0].claimedAt = null
    h.rows[0].completedAt = NOW
    h.rows[0].outcome = "REVIEWED"
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.review).not.toHaveBeenCalled()
  })

  it("a crash mid-review leaves the row open for the sweep, never marks it complete", async () => {
    h.review.mockRejectedValueOnce(new Error("db down"))
    h.rows.push(due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.rows[0].completedAt).toBeNull()
    expect(h.logError).toHaveBeenCalledWith(expect.stringContaining("sweep will retry"), expect.objectContaining({ applicationId: "a1" }))
  })

  it("records a skip reason or a refused review as the outcome", async () => {
    h.review.mockResolvedValueOnce({ status: "SKIPPED", reason: "application_not_submitted" })
    h.rows.push(due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.rows[0].outcome).toBe("application_not_submitted")
    h.rows.push(due({ applicationId: "a2" }))
    h.review.mockResolvedValueOnce({ status: "REVIEW_REFUSED", httpStatus: 422 })
    await runDigitalDue({ tenantId: "t", applicationId: "a2", now: NOW })
    expect(h.rows[1].outcome).toBe("REVIEW_REFUSED_422")
  })
})

const charged = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => due({ applicationId: `earlier-${over.clientId ?? "c"}-${over.ip ?? "n"}-${i}`, chargedAt: minutesAgo(60), claimedAt: minutesAgo(60), createdAt: minutesAgo(61), ...over }))
const outcomeOf = (applicationId: string) => h.rows.find((r) => r.applicationId === applicationId)?.outcome

describe("the daily limit on automatic bureau pulls from portal submissions (spam costs money)", () => {
  it("stops a client past the daily limit: no review, no pull, the application stays for staff", async () => {
    h.rows.push(...charged(DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, { ip: "9.9.9.9" }), due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("RATE_LIMITED")
  })
  it("and an address past its own, whoever the clients are", async () => {
    h.rows.push(...Array.from({ length: DIGITAL_REVIEWS_PER_IP_PER_DAY }, (_, i) => due({ applicationId: `x${i}`, clientId: `other-${i}`, chargedAt: minutesAgo(5) })), due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("RATE_LIMITED")
  })
  it("counts a review that is admitted but not finished (the race a completed-only count leaves open)", async () => {
    h.rows.push(...charged(DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, { ip: "9.9.9.9" }).map((r) => ({ ...r, completedAt: null, outcome: null })), due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("RATE_LIMITED")
  })
  it("a charge older than a day no longer counts", async () => {
    h.rows.push(...charged(DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, { ip: "9.9.9.9" }).map((r) => ({ ...r, chargedAt: minutesAgo(25 * 60) })), due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("REVIEWED")
  })
  it("charges the review it admits, so the next one sees it", async () => {
    h.rows.push(due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.rows[0].chargedAt).toEqual(NOW)
  })
  it("a retry of a row that was already charged is not charged or limited again", async () => {
    h.rows.push(...charged(DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, { ip: "9.9.9.9" }), due({ chargedAt: minutesAgo(15), claimedAt: minutesAgo(15), attempts: 1 }))
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("REVIEWED")
    expect(h.rows.at(-1)?.chargedAt).toEqual(minutesAgo(15))
  })
  it("a row with no address shares one bucket per lender, it is not exempt", async () => {
    h.rows.push(...Array.from({ length: DIGITAL_REVIEWS_UNKNOWN_IP_PER_DAY }, (_, i) => due({ applicationId: `u${i}`, clientId: `u-${i}`, ip: null, chargedAt: minutesAgo(5) })), due({ ip: null }))
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("RATE_LIMITED")
  })
  it("another lender's reviews never count against this one", async () => {
    h.rows.push(...charged(DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, { tenantId: "other", ip: "9.9.9.9" }), due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("REVIEWED")
  })
  it("takes the client, address and lender locks before counting, in a fixed order", async () => {
    h.rows.push(due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.lockOrder).toEqual([...h.lockOrder].sort())
    expect(h.lockOrder).toHaveLength(3)
  })
})

describe("the review is admitted after its gates and before its paid pull", () => {
  it("hands the review an admit step; a refusal there is a RATE_LIMITED outcome with no further work", async () => {
    h.rows.push(...charged(DIGITAL_REVIEWS_PER_CLIENT_PER_DAY, { ip: "9.9.9.9" }), due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.review).toHaveBeenCalledWith(expect.objectContaining({ admit: expect.any(Function) }))
    expect(outcomeOf("a1")).toBe("RATE_LIMITED")
  })
  it("a review the gates stop never reaches admit, so it never uses a slot", async () => {
    h.review.mockResolvedValueOnce({ status: "REVIEW_REFUSED", httpStatus: 422 })
    h.rows.push(due())
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(h.rows[0].chargedAt ?? null).toBeNull()
    expect(outcomeOf("a1")).toBe("REVIEW_REFUSED_422")
  })
})

describe("the lender-wide daily ceiling on automatic paid pulls", () => {
  it("stops every submitter once the lender has used its ceiling, whoever they are", async () => {
    h.rows.push(...Array.from({ length: 4 }, (_, i) => due({ applicationId: `x${i}`, clientId: `other-${i}`, ip: `10.0.0.${i}`, chargedAt: minutesAgo(5) })), due({ ip: "10.9.9.9" }))
    const row = h.rows.at(-1) as { id: string; tenantId: string; clientId: string; ip: string | null; chargedAt: Date | null }
    expect(await admitDigitalReview(h.tx as never, row, NOW, 4)).toBe(false)
    expect(await admitDigitalReview(h.tx as never, row, NOW, 5)).toBe(true)
  })
  it("defaults to 200 a day and is read from DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY", () => {
    expect(digitalReviewsPerLenderPerDay({})).toBe(200)
    expect(digitalReviewsPerLenderPerDay({ DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY: "25" })).toBe(25)
    expect(digitalReviewsPerLenderPerDay({ DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY: "0" })).toBe(200)
    expect(digitalReviewsPerLenderPerDay({ DIGITAL_AUTO_PULLS_PER_LENDER_PER_DAY: "lots" })).toBe(200)
  })
})

describe("ipBucket: an IPv6 subscriber holds a /64, a zone id is not part of the address, junk is the unknown bucket", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:0db8:0001:0002::/64"],
    ["2001:db8:1:2:1111:2222:3333:4444", "2001:0db8:0001:0002::/64"],
    ["2001:DB8:1:2::7", "2001:0db8:0001:0002::/64"],
    ["2001:db8::1", "2001:0db8:0000:0000::/64"],
    ["fe80::1%eth0", "fe80:0000:0000:0000::/64"],
    ["::ffff:198.51.100.4", "198.51.100.4"],
    ["::1", "0000:0000:0000:0000::/64"],
    [`2001:db8::1%${"z".repeat(100)}`, "2001:0db8:0000:0000::/64"],
  ])("%s -> %s", (ip, bucket) => { expect(ipBucket(ip)).toBe(bucket) })
  it.each([[null], [""], ["not an address"], ["1.2.3.4.5"], ["x".repeat(200)]])("%j is the unknown bucket", (ip) => {
    expect(ipBucket(ip as string | null)).toBeNull()
  })
  it("a whole /64 shares one slot allowance, so rotating addresses inside it is no way round the limit", async () => {
    h.rows.push(...Array.from({ length: DIGITAL_REVIEWS_PER_IP_PER_DAY }, (_, i) => due({ applicationId: `v6-${i}`, clientId: `o${i}`, ip: ipBucket(`2001:db8:1:2::${i + 1}`), chargedAt: minutesAgo(5) })), due({ ip: ipBucket("2001:db8:1:2:ffff::9") }))
    await runDigitalDue({ tenantId: "t", applicationId: "a1", now: NOW })
    expect(outcomeOf("a1")).toBe("RATE_LIMITED")
  })
  it("stores the bucket, never the raw address, and an over-long address as the unknown bucket (no insert error)", async () => {
    await markDigitalDecisionDue({ tenantId: "t", applicationId: "a1", clientId: "c1", ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd%eth0" })
    await markDigitalDecisionDue({ tenantId: "t", applicationId: "a2", clientId: "c1", ip: "9".repeat(500) })
    expect(h.rows.map((r) => r.ip)).toEqual(["2001:0db8:0001:0002::/64", null])
  })
})

describe("sweepDigitalDecisions: a task lost to a restart is found and run", () => {
  it("picks up an open row older than the grace period that nobody holds, and completes it", async () => {
    h.rows.push(due({ createdAt: minutesAgo(DIGITAL_SWEEP_AFTER_MINUTES + 2) }))
    const result = await sweepDigitalDecisions({ now: NOW })
    expect(result).toMatchObject({ swept: 1, failed: 0 })
    expect(h.review).toHaveBeenCalledTimes(1)
    expect(h.rows[0].outcome).toBe("REVIEWED")
  })
  it("leaves a fresh row to its own after-response task", async () => {
    h.rows.push(due({ createdAt: minutesAgo(1) }))
    await sweepDigitalDecisions({ now: NOW })
    expect(h.review).not.toHaveBeenCalled()
  })
  it("leaves a row another worker claimed a moment ago, retakes one whose claim went stale", async () => {
    h.rows.push(due({ applicationId: "held", claimedAt: minutesAgo(1) }), due({ applicationId: "stale", claimedAt: minutesAgo(30) }))
    await sweepDigitalDecisions({ now: NOW })
    expect(h.review).toHaveBeenCalledTimes(1)
    expect(h.review).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t", applicationId: "stale" }))
  })
  it("ignores completed rows, and gives up on a row that has failed too often", async () => {
    h.rows.push(due({ applicationId: "done", completedAt: minutesAgo(8), outcome: "REVIEWED" }), due({ applicationId: "bad", attempts: DIGITAL_MAX_ATTEMPTS }))
    const result = await sweepDigitalDecisions({ now: NOW })
    expect(h.review).not.toHaveBeenCalled()
    expect(h.rows[1].outcome).toBe("GAVE_UP")
    expect(result.gaveUp).toBe(1)
  })

  it("counts a review that threw as failed, not swept (so the cron answers 503 and the failure is seen)", async () => {
    h.review.mockRejectedValueOnce(new Error("db down"))
    h.rows.push(due({ createdAt: minutesAgo(DIGITAL_SWEEP_AFTER_MINUTES + 2) }))
    expect(await sweepDigitalDecisions({ now: NOW })).toMatchObject({ swept: 0, failed: 1 })
    expect(h.rows[0].completedAt ?? null).toBeNull()
  })

  it("prunes finished rows after the retention period, keeping recent ones (the limits read them) and open ones", async () => {
    h.rows.push(due({ applicationId: "old", completedAt: minutesAgo(31 * 24 * 60), outcome: "REVIEWED" }), due({ applicationId: "recent", completedAt: minutesAgo(60), outcome: "REVIEWED" }), due({ applicationId: "open", createdAt: minutesAgo(1) }))
    const result = await sweepDigitalDecisions({ now: NOW })
    expect(result.pruned).toBe(1)
    expect(h.rows.map((r) => r.applicationId).sort()).toEqual(["open", "recent"])
  })
})
