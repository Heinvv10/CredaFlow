import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { GuidePanelData } from "@/lib/valuation-guides/guide-panel"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { GuideValuePanel } from "./GuideValuePanel"

const candidate = (variant: string, tradeCents: number) => ({
  guideRowId: `r-${variant || "base"}`, guideId: "g-1", guideName: "TEST Plant Guide", effectiveOn: "2026-02-01", simulated: false,
  make: "TEST", model: "EX-1", year: 2025, variant, tradeCents, retailCents: tradeCents + 20_000_000,
})
const latest = (simulated = false) => ({
  id: "v-1", valuedOn: "2026-10-21", amountCents: 120_000_000,
  snapshot: {
    guideId: "g-1", guideName: "TEST Plant Guide", effectiveOn: "2026-02-01", provider: "csv", simulated, rowId: "r-base", lineNumber: 2,
    make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 120_000_000, retailCents: 140_000_000,
  },
})
const render = (data: GuidePanelData, canManage = true) => renderToStaticMarkup(GuideValuePanel({ assetId: "a-1", data, canManage }))

describe("GuideValuePanel", () => {
  it("shows the latest guide value and, on a deal, the advance's LTV against trade and retail", () => {
    const out = render({ candidates: [candidate("", 120_000_000)], latest: latest(), advance: { cents: 150_250_000, tradeLtvBps: 12_521, retailLtvBps: 10_732 } })
    expect(out).toContain("TEST Plant Guide · effective")
    expect(out).toContain("125.21%")
    expect(out).toContain("107.32%")
    expect(out).toContain("still need an independent valuation")
    expect(out).toContain("Record guide value")
    expect(out).not.toContain("Simulated guide")
  })

  it("labels a simulated guide's value, and a simulated guide's rows among the choices", () => {
    expect(render({ candidates: [], latest: latest(true), advance: null })).toContain("Simulated guide")
    const choices = render({ candidates: [{ ...candidate("", 1), simulated: true }, candidate("Long reach", 2)], latest: null, advance: null })
    expect(choices).toContain("TEST Plant Guide (2026-02-01, simulated) · no variant")
    expect(choices).toContain("TEST Plant Guide (2026-02-01) · Long reach")
  })

  it("offers no recording to a role that cannot manage, and says when no guide row matches", () => {
    const reader = render({ candidates: [candidate("", 1), candidate("Long reach", 2)], latest: null, advance: null }, false)
    expect(reader).toContain("2 current guide row(s) match this asset")
    expect(reader).not.toContain("Record guide value")
    expect(render({ candidates: [], latest: null, advance: { cents: 1, tradeLtvBps: null, retailLtvBps: null } }))
      .toContain("No published guide has a row for this asset")
  })
})
