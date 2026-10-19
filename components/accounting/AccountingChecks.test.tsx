import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ASSET_FINANCE_ROLES } from "@/lib/accounting/accounts"
import { controlLabel, refusalCopy } from "./accounting-text"
import { ControlsList, RefusalNotice } from "./AccountingChecks"
import { ConfirmedRoles } from "./ConfirmedRoles"

describe("refusal text", () => {
  it.each(["AF_CONTROL_FAILED", "AF_SOURCE_UNSUPPORTED", "MAPPING_NOT_CONFIRMED", "RECONCILIATION_FAILED", "OUT_OF_ORDER", "PERIOD_NOT_ENDED", "GO_LIVE_NOT_SET"])(
    "%s has plain words, not the code",
    (code) => {
      const copy = refusalCopy(code)
      expect(copy.title.length).toBeGreaterThan(10)
      expect(copy.title).not.toMatch(/_/)
      expect(copy.advice).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/)
    },
  )

  it("falls back for a code it does not know", () => {
    expect(refusalCopy("SOMETHING_NEW").title).toBe("This month cannot close yet")
  })

  it("names every asset-finance control", () => {
    for (const control of ["AF_OUTPUT_VAT", "AF_INPUT_VAT", "RECOVERY_CLEARING", "RECOVERY_RESULT", "RECOVERY_REFUND_PAYABLE", "MAINTENANCE_FUND_LIABILITY"]) {
      expect(controlLabel(control)).not.toMatch(/[A-Z_]{4,}/)
    }
  })
})

describe("RefusalNotice", () => {
  it("shows the title, the advice and the server's sentence", () => {
    const html = renderToStaticMarkup(<RefusalNotice refusal={{ code: "AF_CONTROL_FAILED", message: "1 asset-finance control(s) do not tie: AF_OUTPUT_VAT jrn-lr (journal -18000, books -18001)" }} />)
    expect(html).toContain("An asset-finance check does not agree with the contract records")
    expect(html).toContain("Nothing is posted until the differences are resolved")
    expect(html).toContain("jrn-lr")
    expect(html).toContain('data-refusal="AF_CONTROL_FAILED"')
  })

  it("explains an unconfirmed asset-finance mapping and keeps the roles from the server", () => {
    const html = renderToStaticMarkup(<RefusalNotice refusal={{ code: "MAPPING_NOT_CONFIRMED", message: "posts asset-finance accounts (AF_INSTALMENT_DEBTORS)" }} />)
    expect(html).toContain("The chart of accounts needs confirming")
    expect(html).toContain("confirm again before the first month that posts them")
    expect(html).toContain("AF_INSTALMENT_DEBTORS")
  })

  it("uses design tokens, not colours", () => {
    const html = renderToStaticMarkup(<RefusalNotice refusal={{ code: "AF_SOURCE_UNSUPPORTED", message: "x" }} />)
    expect(html).toContain("var(--cf-")
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
})

describe("ControlsList", () => {
  it("renders nothing when every check ties", () => {
    expect(renderToStaticMarkup(<ControlsList controls={[]} />)).toBe("")
  })

  it("lists each difference by contract reference with both figures in rands", () => {
    const html = renderToStaticMarkup(<ControlsList controls={[
      { control: "AF_OUTPUT_VAT", key: "loan-1", reference: "AF-LR-0001", journalCents: -18_000, bookCents: -18_001 },
      { control: "RECOVERY_RESULT", key: "rec-9", journalCents: 4_350_100, bookCents: 4_350_000 },
    ]} />)
    expect(html).toContain("2 asset-finance checks differ")
    expect(html).toContain("Output VAT on tax invoices, less credit notes")
    expect(html).toContain("AF-LR-0001")
    expect(html).toContain("rec-9")
    expect(html).toContain("contract records")
    expect(html).toContain("R 43,501.00")
    expect(html).toContain("R -180.01")
  })

  it("caps the list and says how many more", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ control: "AF_INPUT_VAT", key: `k${i}`, journalCents: 1, bookCents: 2 }))
    const html = renderToStaticMarkup(<ControlsList controls={many} />)
    expect(html).toContain("13 asset-finance checks differ")
    expect(html).toContain("and 3 more")
    expect(html).not.toContain("k12")
  })
})

describe("ConfirmedRoles", () => {
  it("says none are confirmed for a mapping confirmed before asset finance", () => {
    const html = renderToStaticMarkup(<ConfirmedRoles confirmed={[]} mappingConfirmed />)
    expect(html).toContain(`0 of ${ASSET_FINANCE_ROLES.length} confirmed`)
    expect(html).toContain("Instalment sale and finance lease debtors")
    expect(html).toContain("closes only after the mapping is confirmed again")
  })

  it("is fully confirmed once every asset-finance role is listed", () => {
    const html = renderToStaticMarkup(<ConfirmedRoles confirmed={[...ASSET_FINANCE_ROLES]} mappingConfirmed />)
    expect(html).toContain(`${ASSET_FINANCE_ROLES.length} of ${ASSET_FINANCE_ROLES.length} confirmed`)
    expect(html).not.toContain("Not yet confirmed")
  })

  it("lists only the roles still missing", () => {
    const html = renderToStaticMarkup(<ConfirmedRoles confirmed={ASSET_FINANCE_ROLES.filter((r) => r !== "RECOVERY_RESULT")} mappingConfirmed />)
    expect(html).toContain("17 of 18 confirmed")
    expect(html).toContain("Not yet confirmed: Recovery result.")
  })

  it("counts none as confirmed while the mapping itself is not confirmed", () => {
    expect(renderToStaticMarkup(<ConfirmedRoles confirmed={[...ASSET_FINANCE_ROLES]} mappingConfirmed={false} />)).toContain("0 of 18 confirmed")
  })
})
