import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ReferralAgentField } from "./ReferralAgentField"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const AGENTS = {
  agents: [
    { status: "ACTIVE", displayName: "Outgoing Agent", referralCodes: [{ id: "code-a", code: "AAA", status: "ACTIVE" }] },
    { status: "ACTIVE", displayName: "Agent Two", referralCodes: [{ id: "code-b", code: "BBB", status: "ACTIVE" }] },
  ],
}

const EMPTY_IMPACT = {
  accrue: [], reverse: [], skipped: [], blockers: [],
  totalAccrueCents: 0, totalReverseCents: 0, reverseUnknownCount: 0,
}

let impact: unknown = EMPTY_IMPACT
let impactOk = true
const impactUrls: string[] = []

/** Routes by URL: this component makes TWO fetches and a single stub would make
 *  the impact assertion pass on the agent-list response instead. */
function stubFetch() {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/agent-hub/agents")) {
      return { ok: true, status: 200, json: async () => AGENTS } as Response
    }
    impactUrls.push(url)
    if (!impactOk) return { ok: false, status: 500, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => impact } as Response
  })
}

async function renderField(over: Record<string, unknown> = {}) {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      <ReferralAgentField
        clientId="client-1"
        initialCodeId="code-a"
        initialCodeLabel="Outgoing Agent"
        canEdit
        {...over}
      />,
    )
  })
  return renderer
}

// Money reaches the DOM through lib/loan-calculator's formatZAR — the UI
// channel, whose separator is a NON-BREAKING space. Written as an escape
// rather than pasted, so a plain space cannot silently creep in and make
// these assertions pass against the wrong formatter (lib/utils.ts keeps the
// plain-space one for SMS and NCA documents).
const zar = (cents: number) => `R\u00A0${(cents / 100).toFixed(2)}`

async function selectCode(renderer: ReactTestRenderer, value: string) {
  const select = renderer.root.findByType("select")
  await act(async () => {
    select.props.onChange({ target: { value } })
  })
}

function text(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON())
}

beforeEach(() => {
  impact = EMPTY_IMPACT
  impactOk = true
  impactUrls.length = 0
  vi.stubGlobal("fetch", stubFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ReferralAgentField impact preview", () => {
  it("shows the rand amount and every loan the incoming agent would be credited", async () => {
    impact = {
      ...EMPTY_IMPACT,
      accrue: [
        { loanReference: "LN-TEST-0001", principalCents: 100_000, commissionCents: 1_000 },
        { loanReference: "LN-TEST-0002", principalCents: 120_000, commissionCents: 1_200 },
      ],
      totalAccrueCents: 2_200,
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    expect(impactUrls[0]).toBe("/api/clients/client-1/referral-impact?codeId=code-b")
    expect(rendered).toContain(zar(2_200))
    expect(rendered).toContain("2 past loans")
    expect(rendered).toContain("LN-TEST-0001")
    expect(rendered).toContain("LN-TEST-0002")
  })

  it("states what the outgoing agent loses", async () => {
    impact = {
      ...EMPTY_IMPACT,
      reverse: [{ loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900 }],
      totalReverseCents: 900,
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    expect(rendered).toContain("Outgoing Agent")
    expect(rendered).toContain(zar(900))
  })

  // Staff read this, not engineers: CLAWED_BACK means nothing to a loan admin.
  it("names the loans it will not credit and why, in words", async () => {
    impact = {
      ...EMPTY_IMPACT,
      skipped: [
        { loanReference: "LN-0003", reason: "CLAWED_BACK" },
        { loanReference: "LN-0004", reason: "INELIGIBLE_LOAN_STATUS" },
      ],
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    expect(rendered).toContain("LN-0003")
    expect(rendered).toContain("LN-0004")
    expect(rendered).not.toContain("CLAWED_BACK")
    expect(rendered).not.toContain("INELIGIBLE_LOAN_STATUS")
    expect(rendered).toMatch(/clawed back|written off|defaulted/i)
  })

  // INELIGIBLE_LOAN_STATUS fires for DEFAULTED, WRITTEN_OFF,
  // PENDING_WRITE_OFF and CANCELLED alike — every LoanStatus outside the
  // backfill allow-list. Naming only two of them stated something untrue about
  // the other two on a screen an operator acts on.
  it("phrases the ineligible-status reason truthfully for every status it covers", async () => {
    impact = {
      ...EMPTY_IMPACT,
      skipped: [{ loanReference: "LN-0007", reason: "INELIGIBLE_LOAN_STATUS" }],
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    expect(rendered).toContain("LN-0007")
    // Must not claim the loan is specifically defaulted or written off; a
    // CANCELLED loan reaches this same reason.
    expect(rendered).not.toMatch(/defaulted or written off/i)
    expect(rendered).toMatch(/does not earn commission|not eligible/i)
  })

  // NO_CLAWBACK_PATH and UNKNOWN_ROW_STATUS are reasons this change
  // introduced, so they are exactly the ones a phrasing table forgets.
  it.each(["NO_CLAWBACK_PATH", "UNKNOWN_ROW_STATUS"])(
    "phrases %s for staff rather than showing the enum",
    async (reason) => {
      impact = { ...EMPTY_IMPACT, skipped: [{ loanReference: "LN-0006", reason }] }
      const renderer = await renderField()
      await selectCode(renderer, "code-b")

      const rendered = text(renderer)
      expect(rendered).toContain("LN-0006")
      expect(rendered).not.toContain(reason)
    },
  )

  // Every reason the planner can emit has phrasing. A table that drifts from the
  // union is how an operator ends up reading UNKNOWN_ROW_STATUS off a screen.
  it("has phrasing for every reason the planner can produce", async () => {
    const reasons = [
      "INELIGIBLE_LOAN_STATUS", "AGENT_NOT_ACTIVE", "CODE_NOT_ACTIVE", "SELF_REFERRAL",
      "ZERO_RATE", "ALREADY_ACCRUED", "WITHHELD_ROW_EXISTS", "UNKNOWN_ROW_STATUS",
      "CLAWED_BACK", "NO_CLAWBACK_PATH",
    ]
    impact = {
      ...EMPTY_IMPACT,
      skipped: reasons.map((reason, i) => ({ loanReference: `LN-100${i}`, reason })),
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    for (const reason of reasons) expect(rendered).not.toContain(reason)
  })

  // A reason with no phrasing yet must still say SOMETHING identifiable rather
  // than rendering blank and hiding an exclusion from the operator.
  it("falls back to the raw reason rather than showing nothing", async () => {
    impact = {
      ...EMPTY_IMPACT,
      skipped: [{ loanReference: "LN-0005", reason: "SOME_FUTURE_REASON" }],
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    expect(text(renderer)).toContain("SOME_FUTURE_REASON")
  })

  // MED-4. The empty state ignored `skipped`, so a move where every loan was
  // excluded rendered the skip lines AND "no changes with this move" together.
  it("does not claim there is nothing to do while listing exclusions", async () => {
    impact = {
      ...EMPTY_IMPACT,
      skipped: [{ loanReference: "LN-0003", reason: "CLAWED_BACK" }],
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    expect(text(renderer)).not.toMatch(/no past loan commission changes/i)
  })

  it("still says so when there is genuinely nothing to do", async () => {
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    expect(text(renderer)).toMatch(/no past loan commission changes/i)
  })

  // NEW-3. commissionCents is Int?. "R 0.00" states a figure nobody recorded,
  // on the surface an operator uses to approve a payout.
  it("admits an unrecorded reversal amount rather than showing it as zero", async () => {
    impact = {
      ...EMPTY_IMPACT,
      reverse: [
        { loanReference: "LN-0001", agentName: "Agent One", commissionCents: 900 },
        { loanReference: "LN-0002", agentName: "Agent One", commissionCents: null },
      ],
      totalReverseCents: 900,
      reverseUnknownCount: 1,
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    expect(rendered).toContain("LN-0002")
    expect(rendered).not.toContain(zar(0))
    expect(rendered).toMatch(/not recorded|no recorded amount/i)
  })

  // The total is a sum of KNOWN amounts. If it cannot account for every row it
  // must not be presented as though it did.
  it("qualifies a reversal total that cannot account for every row", async () => {
    impact = {
      ...EMPTY_IMPACT,
      reverse: [{ loanReference: "LN-0002", agentName: "Agent One", commissionCents: null }],
      totalReverseCents: 0,
      reverseUnknownCount: 1,
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    // Both halves of the qualification: the figure is prefixed as a floor, AND
    // the sentence says how many rows it cannot account for. Asserting either
    // alone lets the other be dropped silently.
    expect(rendered).toMatch(/at least/i)
    expect(rendered).toMatch(/excludes 1 row with no recorded amount/i)
  })

  // Each reversal is labelled with ITS OWN agent. Labelling the whole list with
  // reverse[0] misattributes every other row when two agents' rows are in it.
  it("names the agent on each reversal, not just the first", async () => {
    impact = {
      ...EMPTY_IMPACT,
      reverse: [
        { loanReference: "LN-0001", agentName: "Agent One", commissionCents: 900 },
        { loanReference: "LN-0002", agentName: "Agent Two", commissionCents: 500 },
      ],
      totalReverseCents: 1_400,
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    expect(rendered).toContain("Agent One")
    expect(rendered).toContain("Agent Two")
  })

  // MED-3's UI half: the write is bound to the figures shown here.
  it("reports the previewed totals so the save can be bound to them", async () => {
    impact = {
      ...EMPTY_IMPACT,
      accrue: [{ loanReference: "LN-0001", principalCents: 100_000, commissionCents: 1_000 }],
      totalAccrueCents: 1_000,
      totalReverseCents: 900,
    }
    const onImpactChange = vi.fn()
    const renderer = await renderField({ onImpactChange })
    await selectCode(renderer, "code-b")

    expect(onImpactChange).toHaveBeenLastCalledWith({
      blocked: false, totalAccrueCents: 1_000, totalReverseCents: 900,
    })
  })

  it("withdraws the totals when the select returns to the stored value", async () => {
    const onImpactChange = vi.fn()
    const renderer = await renderField({ onImpactChange })
    await selectCode(renderer, "code-b")
    await selectCode(renderer, "code-a")

    expect(onImpactChange).toHaveBeenLastCalledWith(null)
  })

  it("reports a blocker upward so the form can refuse the save", async () => {
    impact = {
      ...EMPTY_IMPACT,
      blockers: [{ kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" }],
    }
    const onImpactChange = vi.fn()
    const renderer = await renderField({ onImpactChange })
    await selectCode(renderer, "code-b")

    expect(onImpactChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ blocked: true }),
    )
    expect(text(renderer)).toContain("LN-0001")
  })

  // A blocker stops the whole Save, so the way out of it has to be on screen —
  // otherwise an operator who came to fix a phone number is simply stuck.
  it("tells the operator how to get their other edits saved", async () => {
    impact = {
      ...EMPTY_IMPACT,
      blockers: [{ kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" }],
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")

    const rendered = text(renderer)
    // Names the value to go back to, not just "revert".
    expect(rendered).toMatch(/set the referral agent back to/i)
    expect(rendered).toContain("Outgoing Agent")
  })

  // LOAD-FAILURE CONTRACT: the accrual is computed server-side regardless, so
  // blocking an unrelated client edit on a failed PREVIEW fetch would be worse
  // than saving without the preview.
  it("admits a failed preview and still allows the save", async () => {
    impactOk = false
    const onImpactChange = vi.fn()
    const renderer = await renderField({ onImpactChange })
    await selectCode(renderer, "code-b")

    expect(text(renderer)).toMatch(/could not be calculated|unavailable/i)
    // No totals to bind the write to, and NOT blocked: the accrual is computed
    // server-side either way.
    expect(onImpactChange).toHaveBeenLastCalledWith(null)
  })

  it("asks for no impact and clears the preview when the value returns to the stored one", async () => {
    impact = {
      ...EMPTY_IMPACT,
      accrue: [{ loanReference: "LN-0001", principalCents: 100_000, commissionCents: 1_000 }],
      totalAccrueCents: 1_000,
    }
    const renderer = await renderField()
    await selectCode(renderer, "code-b")
    expect(text(renderer)).toContain("LN-0001")

    await selectCode(renderer, "code-a")

    expect(impactUrls).toHaveLength(1)
    expect(text(renderer)).not.toContain("LN-0001")
  })

  it("previews clearing the agent as a reversal with nothing credited", async () => {
    impact = {
      ...EMPTY_IMPACT,
      reverse: [{ loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900 }],
      totalReverseCents: 900,
    }
    const renderer = await renderField()
    await selectCode(renderer, "")

    expect(impactUrls[0]).toBe("/api/clients/client-1/referral-impact")
    expect(text(renderer)).toContain(zar(900))
  })

  // A read-only field posts no key and can move no commission, so it must not
  // go asking what another agent earns either — nor even load the agent list.
  it("fetches nothing at all when the field is read-only", async () => {
    const renderer = await renderField({ canEdit: false })

    expect(renderer.root.findAllByType("select")).toHaveLength(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  // LOAD-FAILURE CONTRACT: with no supplied current value the field must not
  // render a select, because an empty select posts null and erases the stored
  // attribution on an unrelated edit.
  it("renders no select, and asks for nothing, when the current value is unknown", async () => {
    const renderer = await renderField({ initialCodeId: undefined })

    expect(renderer.root.findAllByType("select")).toHaveLength(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
