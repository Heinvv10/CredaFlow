import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { SurrenderRequestCard } from "./SurrenderRequestCard"

const html = (props: Partial<Parameters<typeof SurrenderRequestCard>[0]>) => renderToStaticMarkup(<SurrenderRequestCard loanId="l-1" existing={null} {...props} />)

describe("SurrenderRequestCard", () => {
  it("offers the request by default", () => {
    expect(html({})).toContain("Request voluntary surrender")
  })

  it("offers no request once the lender holds the asset", () => {
    expect(html({ canRequest: false })).toBe("")
  })

  it("still shows an existing request's status and notices when no new request can be made", () => {
    const out = html({ canRequest: false, existing: { id: "s-1", status: "VALUATION_NOTICE_ISSUED" } })
    expect(out).toContain("Voluntary surrender recorded")
    expect(out).toContain("valuation notice issued")
    expect(out).toContain("/api/portal/asset-finance/surrenders/s-1/documents/valuation")
    expect(out).not.toContain("Request voluntary surrender")
  })
})
