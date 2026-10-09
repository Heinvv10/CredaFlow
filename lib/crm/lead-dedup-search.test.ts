import { describe, it, expect } from "vitest"
import {
  findLeadDuplicates,
  DEDUP_SCAN_LIMIT,
  type LeadFinder,
  type DedupCandidateLead,
} from "@/lib/crm/lead-dedup-search"

// These tests exist for the two halves of the query that fail SILENTLY:
//
//   1. the manual `tenantId` filter — `Lead` is absent from
//      TENANT_SCOPED_MODELS, so nothing injects it, and dropping it leaks one
//      tenant's leads into another's screen while every other test stays green;
//   2. the `+ 1` over-fetch — drop it and `truncated` is pinned to false
//      forever, which is exactly the undercount-reads-as-all-clear failure the
//      field exists to report.
//
// Both are invisible to the pure rule's tests, which never see a query at all.

function candidate(over: Partial<DedupCandidateLead> & { id: string }): DedupCandidateLead {
  return {
    firstName: "Test",
    lastName: "Lead",
    email: null,
    phone: "0820000000",
    status: "NEW",
    source: "WEBSITE",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  }
}

/** Records the args it was called with so the test can assert on the QUERY. */
function fakeLeads(opts: {
  subject: { id: string; email: string | null; phone: string } | null
  rows: DedupCandidateLead[]
}) {
  const calls: { findFirst: unknown[]; findMany: unknown[] } = { findFirst: [], findMany: [] }
  const leads: LeadFinder = {
    async findFirst(args) {
      calls.findFirst.push(args)
      return opts.subject
    },
    async findMany(args) {
      calls.findMany.push(args)
      return opts.rows.slice(0, args.take)
    },
  }
  return { leads, calls }
}

describe("findLeadDuplicates — the query", () => {
  it("scopes BOTH queries to the tenant", async () => {
    const { leads, calls } = fakeLeads({
      subject: { id: "subj", email: null, phone: "0821234567" },
      rows: [],
    })

    await findLeadDuplicates(leads, "subj", "tenant-abc")

    expect(calls.findFirst[0]).toMatchObject({ where: { id: "subj", tenantId: "tenant-abc" } })
    expect(calls.findMany[0]).toMatchObject({ where: { tenantId: "tenant-abc" } })
  })

  it("excludes the subject in the query itself, not just in the rule", async () => {
    const { leads, calls } = fakeLeads({
      subject: { id: "subj", email: null, phone: "0821234567" },
      rows: [],
    })

    await findLeadDuplicates(leads, "subj", "t1")

    expect(calls.findMany[0]).toMatchObject({ where: { id: { not: "subj" } } })
  })

  it("over-fetches by exactly one row so truncation is detectable", async () => {
    // A literal +1 against the real constant. Without the probe row a full page
    // is indistinguishable from a page that merely filled the cap, and
    // `truncated` can never become true.
    const { leads, calls } = fakeLeads({
      subject: { id: "subj", email: null, phone: "0821234567" },
      rows: [],
    })

    await findLeadDuplicates(leads, "subj", "t1")

    expect(calls.findMany[0]).toMatchObject({ take: DEDUP_SCAN_LIMIT + 1 })
  })

  it("orders newest-first so truncation drops the oldest", async () => {
    const { leads, calls } = fakeLeads({
      subject: { id: "subj", email: null, phone: "0821234567" },
      rows: [],
    })

    await findLeadDuplicates(leads, "subj", "t1")

    expect(calls.findMany[0]).toMatchObject({ orderBy: { createdAt: "desc" } })
  })

  it("reports a duplicate found among the candidates", async () => {
    const { leads } = fakeLeads({
      subject: { id: "subj", email: null, phone: "0820000574" },
      rows: [
        candidate({ id: "dupe", phone: "+27820000574" }),
        candidate({ id: "other", phone: "0119998888" }),
      ],
    })

    const report = await findLeadDuplicates(leads, "subj", "t1")

    expect(report.duplicates.map((d) => d.lead.id)).toEqual(["dupe"])
    expect(report.scanned).toBe(2)
    expect(report.truncated).toBe(false)
  })

  it("returns an empty report when the lead is not in this tenant", async () => {
    // findFirst missing = wrong tenant or no such lead. Must not then scan.
    const { leads, calls } = fakeLeads({ subject: null, rows: [candidate({ id: "x" })] })

    const report = await findLeadDuplicates(leads, "subj", "t1")

    expect(report).toEqual({ duplicates: [], scanned: 0, truncated: false })
    expect(calls.findMany).toHaveLength(0)
  })

  it("reports truncated when the probe row comes back", async () => {
    // DEDUP_SCAN_LIMIT + 1 rows available: the cap bound.
    const rows = Array.from({ length: DEDUP_SCAN_LIMIT + 1 }, (_, i) =>
      candidate({ id: `c${i}`, phone: "0119998888" })
    )
    const { leads } = fakeLeads({
      subject: { id: "subj", email: null, phone: "0821234567" },
      rows,
    })

    const report = await findLeadDuplicates(leads, "subj", "t1")

    expect(report.truncated).toBe(true)
    expect(report.scanned).toBe(DEDUP_SCAN_LIMIT)
  })
})
