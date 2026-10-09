import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { WabaTemplateList, summarise } from "./WabaTemplateList"
import type { WabaTemplate } from "./WabaTemplateEditor"

function tpl(over: Partial<WabaTemplate>): WabaTemplate {
  return {
    id: "t1", event: "application_submitted", wabaTemplateName: null, language: "en",
    category: "TRANSACTIONAL", headerContent: null, bodyTemplate: "Hi {{firstName}}, ref {{reference}}",
    footer: null, buttons: null, active: true, providerStatus: null, providerTemplateId: null,
    ...over,
  }
}

const ROWS = [
  tpl({ id: "a", event: "application_submitted", wabaTemplateName: "application_submitted", providerStatus: "PENDING" }),
  tpl({ id: "b", event: "loan_approved", wabaTemplateName: "loan_approved", providerStatus: "APPROVED" }),
  tpl({ id: "c", event: "application_declined" }),
  tpl({ id: "d", event: "loan_disbursed", wabaTemplateName: "loan_disbursed", providerStatus: "REJECTED" }),
  tpl({ id: "e", event: "agent_freeform_reply", bodyTemplate: null }),
]

describe("summarise", () => {
  it("counts each state so the header answers 'where do we stand'", () => {
    expect(summarise(ROWS)).toEqual({ approved: 1, pending: 1, rejected: 1, notSubmitted: 2, total: 5 })
  })
})

describe("WabaTemplateList", () => {
  // The whole point of this component. The dropdown it replaces showed one
  // template at a time, so answering "which are approved / still pending /
  // never submitted" meant selecting all nine in turn and reading a badge.
  it("shows every template's status at once, without selecting anything", () => {
    const html = renderToStaticMarkup(<WabaTemplateList rows={ROWS} selectedId={null} onSelect={() => {}} />)
    for (const ev of ["application_submitted", "loan_approved", "application_declined", "loan_disbursed", "agent_freeform_reply"]) {
      expect(html, `${ev} missing from the list`).toContain(ev)
    }
    expect(html).toContain("PENDING")
    expect(html).toContain("APPROVED")
    expect(html).toContain("REJECTED")
    expect(html).toContain("NOT SUBMITTED")
  })

  it("surfaces the counts in the header", () => {
    const html = renderToStaticMarkup(<WabaTemplateList rows={ROWS} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain("1 approved")
    expect(html).toContain("1 pending")
    expect(html).toContain("1 rejected")
    expect(html).toContain("2 not submitted")
  })

  // A row with no body cannot be submitted at all, and that is not the same
  // as "not submitted yet" — without the distinction an operator hunts for a
  // Save button that will never succeed.
  it("marks a row that has no body as not-ready rather than merely unsubmitted", () => {
    const html = renderToStaticMarkup(<WabaTemplateList rows={ROWS} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain("no body yet")
  })

  it("marks the selected row for the reader, not just visually", () => {
    const html = renderToStaticMarkup(<WabaTemplateList rows={ROWS} selectedId="b" onSelect={() => {}} />)
    expect(html).toContain('aria-current="true"')
  })

  it("offers the new-template affordance the dropdown carried", () => {
    const html = renderToStaticMarkup(<WabaTemplateList rows={ROWS} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain("New template")
  })
})

/**
 * The staff app renders DARK via a remap layer in app/globals.css that rewrites
 * plain light-theme Tailwind (bg-white, bg-gray-50/100) to dark tokens. The
 * remap matches literal class names, so an ARBITRARY-VALUE background like
 * bg-[#faf8f6] slips past it and stays light — while the text beside it, being
 * a remapped class, goes light too. Light on light: unreadable.
 *
 * That is precisely what shipped: the selected row's label was invisible on
 * prod. A screenshot caught it; no test did, because rendering to a string
 * cannot see computed colour. Asserting the CLASS VOCABULARY is what a unit
 * test can check, so that is what this does.
 */
describe("dark-remap safety", () => {
  const source = fs.readFileSync(path.join(__dirname, "WabaTemplateList.tsx"), "utf8")

  it("uses no arbitrary-value background — the remap cannot see those", () => {
    const arbitraryBg = source.match(/(?:hover:|focus:|active:)?bg-\[[^\]]+\]/g) ?? []
    expect(
      arbitraryBg,
      "use bg-white / bg-gray-50 / bg-gray-100 so app/globals.css can remap it to a dark token",
    ).toEqual([])
  })
})
