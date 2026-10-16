import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AccountingHistory, type Batch } from "./AccountingHistory"

const batch = (id: string, over: Partial<Batch> = {}): Batch => ({
  id, periodKey: "2026-09", entryCount: 3, lineCount: 6, totalDebitCents: 100, totalCreditCents: 100, closedAt: "2026-10-01T00:00:00Z", xeroPush: null, isaflowPush: null, ...over,
})
const render = (batches: Batch[], xeroConnected: boolean, isaflowConnected: boolean) =>
  renderToStaticMarkup(<AccountingHistory batches={batches} canAdmin xeroConnected={xeroConnected} isaflowConnected={isaflowConnected} busy={false} post={async () => {}} />)

describe("accounting export history", () => {
  it("shows each closed month's IsaFlow push beside its Xero push", () => {
    const html = render([
      batch("b-1", { isaflowPush: { status: "PUSHED", isaflowJournalId: "j-1", foundOnReadBack: false, error: null } }),
      batch("b-2", { isaflowPush: { status: "NEEDS_REVIEW", isaflowJournalId: null, foundOnReadBack: false, error: "check" } }),
      batch("b-3"),
    ], false, true)
    expect(html).toContain(">IsaFlow</th>")
    expect(html).toContain("PUSHED")
    expect(html).toContain("NEEDS REVIEW")
    expect(html.match(/Not pushed/g)).toHaveLength(4)
  })

  it("names both integrations when neither is connected, and only what is connected otherwise", () => {
    expect(render([], false, false)).toContain("Connect Xero or IsaFlow under Settings → Integrations")
    const isaflowOnly = render([], false, true)
    expect(isaflowOnly).toContain("IsaFlow as one draft journal")
    expect(isaflowOnly).not.toContain("to Xero")
    expect(render([], true, true)).toContain("manual journal per month to Xero")
  })
})
