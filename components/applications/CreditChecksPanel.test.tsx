import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"

const router = vi.hoisted(() => ({ refresh: () => {} }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

import { CreditChecksPanel } from "./CreditChecksPanel"
import { CLEAR_REASON_PLACEHOLDER, Evidence, WhyRaised } from "./CreditChecksPanel"
import { CLEAR_REASON_MIN_LENGTH } from "@/lib/credit-checks/policy"

const flag = {
  id: "f1", check: "MANUAL_REVIEW" as const, code: "FIRST_ROW_UNVERIFIED", status: "OPEN" as const, summary: "First row.",
  raisedAt: "2026-10-13T08:00:00Z", clearedAt: null, clearReason: null, clearedByName: null,
  documentId: "doc-1", documentName: "july.pdf", pages: [], rows: [], chainedWith: null,
}

describe("CreditChecksPanel evidence", () => {
  it("names the adjacent statement a boundary row agrees with, as something to compare, not a verdict", () => {
    const html = renderToStaticMarkup(<Evidence flag={{ ...flag, chainedWith: {
      documentId: "doc-2", documentName: "june.pdf", periodStart: "2026-06-01", periodEnd: "2026-06-30", relation: "previous", balanceCents: 580_000,
    } }} />)
    expect(html).toContain("Agrees with the previous statement")
    expect(html).toContain('href="/api/documents/doc-2/view"')
    expect(html).toContain("june.pdf (2026-06-01 to 2026-06-30)")
    expect(html).toContain("closes at R 5 800.00")
    expect(html).toContain("Both come from the client&#x27;s file")
  })

  it("says the next statement opens there, for a last row", () => {
    const html = renderToStaticMarkup(<Evidence flag={{ ...flag, code: "LAST_ROW_UNVERIFIED", chainedWith: {
      documentId: "doc-3", documentName: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", relation: "next", balanceCents: -1_250,
    } }} />)
    expect(html).toContain("Agrees with the next statement")
    expect(html).toContain("opens at -R 12.50")
  })

  it("says nothing about agreement when no adjacent statement agrees", () => {
    expect(renderToStaticMarkup(<Evidence flag={flag} />)).not.toContain("Agrees with")
  })
})

describe("credit-check clear reason minimum", () => {
  // Fair Score audit 2026-10-16: placeholder said 15, the counter another number.
  it("states the policy minimum in the placeholder, as the counter does", () => {
    expect(CLEAR_REASON_PLACEHOLDER).toContain(`at least ${CLEAR_REASON_MIN_LENGTH} characters`)
  })
})

describe("credit-check flag explanation", () => {
  it("shows a collapsible 'Why this was raised' only when the flag has an explanation", () => {
    const html = renderToStaticMarkup(<WhyRaised text="Betting is compared with income." />)
    expect(html).toContain("<details")
    expect(html).toContain("Why this was raised")
    expect(html).toContain("Betting is compared with income.")
    expect(renderToStaticMarkup(<WhyRaised />)).toBe("")
    expect(renderToStaticMarkup(<WhyRaised text="" />)).toBe("")
  })
})

describe("CreditChecksPanel rows", () => {
  afterEach(() => vi.unstubAllGlobals())
  async function panelWith(flags: unknown[]): Promise<ReactTestRenderer> {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ recomputed: true, openCount: flags.length, flags }), { status: 200 })))
    let r: ReactTestRenderer | undefined
    await act(async () => { r = create(<CreditChecksPanel applicationId="app-1" canClear={false} initialOpenCount={flags.length} />) })
    await act(async () => { await new Promise((res) => setTimeout(res, 0)) })
    return r!
  }
  it("puts an explanation in its own flag's row, and none in a row without one", async () => {
    const r = await panelWith([
      { ...flag, id: "f1", code: "GAMBLING", check: "RISK_BEHAVIOUR", explanation: "Betting is compared with income." },
      { ...flag, id: "f2", code: "NO_PAYSLIP", check: "SALARY_MATCH" },
    ])
    const rows = r.root.findAllByProps({ "data-testid": "credit-check-flag" }).filter((n) => typeof n.type === "string")
    const why = (n: (typeof rows)[number]) => n.findAllByProps({ "data-testid": "credit-check-why" }).filter((d) => typeof d.type === "string")
    expect(rows).toHaveLength(2)
    const row = (code: string) => rows.find((n) => n.findAllByType("span").some((s) => s.children.includes(code)))!
    expect(why(row("GAMBLING"))).toHaveLength(1)
    expect(JSON.stringify(why(row("GAMBLING"))[0].children.map((c) => typeof c === "string" ? c : c.children))).toContain("Betting is compared with income.")
    expect(why(row("NO_PAYSLIP"))).toHaveLength(0)
  })
  it("Statement AI off: no explanation block anywhere", async () => {
    const r = await panelWith([{ ...flag, id: "f1", code: "GAMBLING", check: "RISK_BEHAVIOUR" }])
    expect(JSON.stringify(r.toJSON())).not.toContain("Why this was raised")
  })
})
