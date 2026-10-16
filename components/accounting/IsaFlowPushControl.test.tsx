import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { Batch } from "./AccountingHistory"
import { IsaFlowPushControl } from "./IsaFlowPushControl"

const batch = (isaflowPush: Batch["isaflowPush"]): Batch => ({
  id: "b-1", periodKey: "2026-09", entryCount: 3, lineCount: 6, totalDebitCents: 100, totalCreditCents: 100, closedAt: "2026-10-01T00:00:00Z", xeroPush: null, isaflowPush,
})
const render = (push: Batch["isaflowPush"], opts: { canAdmin?: boolean; connected?: boolean } = {}) =>
  renderToStaticMarkup(<IsaFlowPushControl batch={batch(push)} canAdmin={opts.canAdmin ?? true} connected={opts.connected ?? true} busy={false} post={async () => {}} />)
const push = (status: string, extra: Partial<NonNullable<Batch["isaflowPush"]>> = {}) => ({ status, isaflowJournalId: null, foundOnReadBack: false, error: null, ...extra })

describe("IsaFlow push control", () => {
  it("offers the push for a closed month not yet pushed, to an admin, once IsaFlow is connected", () => {
    expect(render(null)).toContain("Push to IsaFlow")
    expect(render(null, { connected: false })).toContain("Connect IsaFlow under Settings")
    expect(render(null, { connected: false })).not.toContain("Push to IsaFlow</button>")
    expect(render(null, { canAdmin: false })).not.toContain("<button")
  })

  it("shows the draft once pushed, and offers nothing more", () => {
    const html = render(push("PUSHED", { isaflowJournalId: "j-77", foundOnReadBack: true }))
    expect(html).toContain("j-77")
    expect(html).toContain("found on read-back")
    expect(html).not.toContain("<button")
  })

  it("offers a check, and a person's answer, for a push with no recorded outcome", () => {
    const html = render(push("NEEDS_REVIEW", { error: "The push never recorded IsaFlow's answer" }))
    expect(html).toContain("Check IsaFlow")
    expect(html).toContain("It is in IsaFlow")
    expect(html).toContain("never recorded")
    expect(render(push("SENDING"))).toContain("Check IsaFlow")
    expect(render(push("FAILED"))).toContain("Push to IsaFlow again")
  })

  it("tells a person to post from the CSV when IsaFlow replays a deleted draft for this month's key", () => {
    const error = "draft deleted in IsaFlow; key replays the old id (j-1). IsaFlow will not create this month again under its key: post it in IsaFlow from the CSV download, then resolve"
    for (const status of ["NEEDS_REVIEW", "FAILED"]) {
      const html = render(push(status, { error }))
      expect(html).toContain("/api/accounting/batches/b-1/csv?format=generic")
      expect(html).not.toContain("re-key")
    }
    expect(render(push("NEEDS_REVIEW", { error }))).toContain("then resolve it here")
    // Pushing again would only replay the deleted draft: no push button, only the CSV.
    expect(render(push("FAILED", { error }))).not.toContain("Push to IsaFlow")
    expect(render(push("FAILED", { error: "IsaFlow refused create_draft_journal: Entry is not balanced" }))).not.toContain("CSV download</a>")
  })
})
