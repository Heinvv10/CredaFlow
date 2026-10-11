import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { compareConversations } from "./ordering"

const row = (lastActivityAt: string | null, id: string) => ({ lastActivityAt, id })

describe("compareConversations", () => {
  it("puts the most recent activity first", () => {
    const sorted = [
      row("2026-07-05T14:29:50.000Z", "b"),
      row("2026-08-04T10:30:04.000Z", "a"),
    ].sort(compareConversations)
    expect(sorted.map((r) => r.id)).toEqual(["a", "b"])
  })

  // THE DEFECT THIS KEY EXISTS FOR. The sort key used to be lastInboundAt,
  // which is null on a thread that has only ever had outbound traffic. NULLS
  // LAST then buried every such thread below every conversation that ever got
  // a reply, however stale — pushing them past the 30-row first page. A recent outbound must outrank an old
  // inbound.
  it("ranks a recent outbound-only thread above an older thread with inbound", () => {
    // lastActivityAt is GREATEST(lastInboundAt, lastOutboundAt): for the
    // outbound-only thread it is the outbound time even though inbound is null.
    const outboundOnly = row("2026-08-19T08:00:00.000Z", "outbound-only")
    const oldInbound = row("2025-01-01T00:00:00.000Z", "old-inbound")
    const sorted = [oldInbound, outboundOnly].sort(compareConversations)
    expect(sorted.map((r) => r.id)).toEqual(["outbound-only", "old-inbound"])
  })

  it("keeps 41 outbound-only threads interleaved by recency, not dumped at the bottom", () => {
    // A mix of 41 outbound-only threads and 65 with inbound.
    const outboundOnly = Array.from({ length: 41 }, (_, i) =>
      row(`2026-08-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`, `out${i}`),
    )
    const withInbound = Array.from({ length: 65 }, (_, i) =>
      row(`2025-0${1 + (i % 9)}-01T00:00:00.000Z`, `in${i}`),
    )
    const firstPage = [...withInbound, ...outboundOnly].sort(compareConversations).slice(0, 30)
    // Every 2026 outbound-only row outranks every 2025 inbound row, so the
    // first page is outbound-only — the exact opposite of the old ordering.
    expect(firstPage.every((r) => r.id.startsWith("out"))).toBe(true)
  })

  it("ranks any real activity above a thread with none", () => {
    const nulls = Array.from({ length: 20 }, (_, i) => row(null, `n${i}`))
    const real = row("2020-01-01T00:00:00.000Z", "old-but-real")
    const sorted = [...nulls, real].sort(compareConversations)
    expect(sorted[0].id).toBe("old-but-real")
  })

  it("is a total order — sorting is stable and reversible", () => {
    const rows = [row(null, "x"), row("2026-01-01T00:00:00.000Z", "y"), row(null, "z")]
    const a = [...rows].sort(compareConversations).map((r) => r.id)
    const b = [...rows].reverse().sort(compareConversations).map((r) => r.id)
    expect(a).toEqual(b)
  })

  it("breaks ties on id descending, matching the server's second orderBy key", () => {
    const t = "2026-08-04T10:30:04.000Z"
    expect([row(t, "a"), row(t, "b")].sort(compareConversations).map((r) => r.id)).toEqual(["b", "a"])
  })

  // A comment asking two files to stay in step is not a control. If someone
  // changes the Prisma orderBy without changing the comparator, the queue
  // silently reshuffles on the first 4s poll tick and the queue order is wrong
  // again — the exact defect this comparator was introduced to stop.
  it("matches the orderBy the server actually issues", () => {
    const source = fs.readFileSync(path.join(__dirname, "conversations.ts"), "utf8")
    expect(source).toContain('orderBy: [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }]')
  })
})
