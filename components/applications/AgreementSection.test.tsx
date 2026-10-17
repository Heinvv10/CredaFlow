import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AgreementSection } from "./AgreementSection"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const baseProps = {
  applicationId: "app-1",
  agreementExecutedDocumentId: null,
  agreementDocumentSha256: "f".repeat(64),
  status: "APPROVED",
  agreementGeneratedAt: "2026-07-23T08:00:00.000Z",
  agreementSignedAt: "2026-07-23T08:30:00.000Z",
  agreementSignedMethod: "portal",
  agreementCountersignedAt: null,
  agreementCountersignedByName: null,
  canCountersign: true,
  providerSignerName: "Jane Provider",
  initiationFeePayment: "DEFERRED" as const,
  initiationFee: 75_000,
  principal: 500_000,
  pasqDocumentSha256: "a".repeat(64),
  pasqAcknowledged: true,
  signingKycBlockers: [],
  clientEmail: "consumer@example.com",
  reference: "APP-TEST-0001",
}

const KYC_BLOCKER = {
  label: "Identity verification outstanding",
  detail: "No selfie has been captured. Capture a selfie or record an in-person verification on the client's KYC tab.",
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

/** Flatten a React node's children to text without JSON.stringify, which hits
 *  circular fiber refs on a mounted tree. */
function nodeText(children: unknown): string {
  if (children == null || typeof children === "boolean") return ""
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(nodeText).join("")
  const el = children as { props?: { children?: unknown } }
  return el.props ? nodeText(el.props.children) : ""
}

describe("AgreementSection provider countersign state", () => {
  it("allows staff to prepare the PASQ and agreement before consumer acknowledgement", () => {
    const html = renderToStaticMarkup(
      <AgreementSection
        {...baseProps}
        agreementSignedAt={null}
        agreementGeneratedAt={null}
        pasqAcknowledged={false}
      />,
    )
    expect(html).toContain("Prepare PASQ + Credit Agreement")
    const button = html.match(/<button(?:(?!<\/button>)[\s\S])*Prepare PASQ \+ Credit Agreement/)?.[0] ?? ""
    expect(button).not.toContain('disabled=""')
    expect(html).toContain("The client reviews and signs both in one sitting")
    expect(html).not.toContain("cannot be generated until they acknowledge")
  })

  it("keeps packet preparation available when the quotation was already acknowledged", () => {
    const html = renderToStaticMarkup(
      <AgreementSection
        {...baseProps}
        agreementSignedAt={null}
        agreementGeneratedAt={null}
        pasqAcknowledged={true}
      />,
    )
    const buttonMatch = html.match(/<button(?:(?!<\/button>)[\s\S])*Prepare PASQ \+ Credit Agreement/)
    expect(buttonMatch?.[0] ?? "").not.toContain('disabled=""')
  })

  it("uses the PASQ generation digest before preparing the agreement", async () => {
    const pasqSha = "b".repeat(64)
    const agreementSha = "c".repeat(64)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ documentSha256: pasqSha }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ contentSha256: agreementSha }),
      })
    vi.stubGlobal("fetch", fetchMock)

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <AgreementSection
          {...baseProps}
          agreementSignedAt={null}
          agreementGeneratedAt={null}
          agreementDocumentSha256={null}
          pasqDocumentSha256={null}
          pasqAcknowledged={false}
        />,
      )
    })
    const prepare = renderer!.root.findByType("button")

    await act(async () => {
      await prepare.props.onClick()
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/applications/app-1/pasq",
      { method: "POST" },
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/applications/app-1/agreement",
      expect.objectContaining({ method: "POST" }),
    )
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Agreement generated and awaiting signature",
    )
    await act(async () => renderer!.unmount())
  })

  it("shows an affirmative countersign action after the consumer signs", () => {
    const html = renderToStaticMarkup(<AgreementSection {...baseProps} />)

    expect(html).toContain("Provider countersignature is still required before disbursement")
    expect(html).toContain("Provider representative signature")
    expect(html).toContain("Jane Provider")
    expect(html).toContain("Countersign Agreement")
    expect(html).toContain("reviewed the exact consumer-signed agreement")
  })

  // Staff downloaded what they believed was the signed agreement and got the
  // signing packet — the PASQ plus the agreement with BLANK signature rules.
  // The executed artifact existed and was correct; no surface served it.
  it("serves the EXECUTED artifact from Download Agreement once one exists", async () => {
    const opened: string[] = []
    const g = globalThis as unknown as { window?: { open?: unknown } }
    if (!g.window) g.window = {}
    const original = g.window.open
    g.window.open = (u: string) => { opened.push(u); return null }
    try {
      let r: ReactTestRenderer
      await act(async () => {
        r = create(
          <AgreementSection
            {...baseProps}
            agreementCountersignedAt="2026-08-05T06:37:36.198Z"
            agreementExecutedDocumentId="exec-doc-1"
          />,
        )
      })
      const btn = r!.root.findAll(
        (n) => n.type === "button" && nodeText(n.props.children).includes("Download Agreement"),
      )[0]
      btn.props.onClick()
      await act(async () => r!.unmount())
    } finally {
      g.window.open = original
    }
    expect(opened[0]).toBe("/api/documents/exec-doc-1/view?download=1")
    expect(opened[0]).not.toContain("signing-packet")
  })

  it("still serves the signing packet before an executed artifact exists", async () => {
    const opened: string[] = []
    const g = globalThis as unknown as { window?: { open?: unknown } }
    if (!g.window) g.window = {}
    const original = g.window.open
    g.window.open = (u: string) => { opened.push(u); return null }
    try {
      let r: ReactTestRenderer
      await act(async () => {
        r = create(<AgreementSection {...baseProps} agreementExecutedDocumentId={null} />)
      })
      const btn = r!.root.findAll(
        (n) => n.type === "button" && nodeText(n.props.children).includes("Download Agreement"),
      )[0]
      btn.props.onClick()
      await act(async () => r!.unmount())
    } finally {
      g.window.open = original
    }
    expect(opened[0]).toContain("/signing-packet")
  })

  it("shows immutable completion evidence and removes the action", () => {
    const html = renderToStaticMarkup(
      <AgreementSection
        {...baseProps}
        agreementCountersignedAt="2026-07-23T08:45:00.000Z"
        agreementCountersignedByName="Jane Provider"
      />,
    )

    expect(html).toContain("provider countersigned by Jane Provider")
    expect(html).not.toContain("Countersign Agreement")
    expect(html).not.toContain("still required before disbursement")
  })

  it("does not expose the countersign control to a lower role", () => {
    const html = renderToStaticMarkup(
      <AgreementSection {...baseProps} canCountersign={false} />,
    )

    expect(html).toContain("Provider countersignature is still required before disbursement")
    expect(html).not.toContain("Countersign Agreement")
  })
})

// The agreement route runs the STRICT composite-KYC gate; approval runs the
// lenient one. An approved application can therefore sit one click away from
// minting a quotation that no agreement can ever follow — which is exactly
// a consumer can end up signing a PASQ believing it is their credit
// agreement.
describe("AgreementSection signing-grade KYC gate", () => {
  it("refuses to mint a quotation when payout-grade KYC is not met", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <AgreementSection
          {...baseProps}
          agreementSignedAt={null}
          agreementGeneratedAt={null}
          agreementDocumentSha256={null}
          pasqDocumentSha256={null}
          pasqAcknowledged={false}
          signingKycBlockers={[KYC_BLOCKER]}
        />,
      )
    })
    const prepare = renderer!.root.findByType("button")
    expect(prepare.props.disabled).toBe(true)

    // The disabled attribute is presentation. The handler itself must refuse,
    // or a stale render still fires the request that mints the PASQ.
    await act(async () => {
      await prepare.props.onClick()
    })
    expect(fetchMock).not.toHaveBeenCalled()

    const rendered = JSON.stringify(renderer!.toJSON())
    expect(rendered).toContain(KYC_BLOCKER.detail)
    expect(rendered).toContain("no credit agreement can follow")
    await act(async () => renderer!.unmount())
  })

  it("prepares the packet normally when there are no signing-grade blockers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documentSha256: "b".repeat(64) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ contentSha256: "c".repeat(64) }) })
    vi.stubGlobal("fetch", fetchMock)

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <AgreementSection
          {...baseProps}
          agreementSignedAt={null}
          agreementGeneratedAt={null}
          agreementDocumentSha256={null}
          pasqDocumentSha256={null}
          pasqAcknowledged={false}
          signingKycBlockers={[]}
        />,
      )
    })
    const prepare = renderer!.root.findByType("button")
    expect(prepare.props.disabled).toBe(false)

    await act(async () => {
      await prepare.props.onClick()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => renderer!.unmount())
  })

  // The banner asserts a fact about a legal document's existence. The shared
  // catch is reachable from the PASQ fetch too — if THAT throws, no quotation
  // was ever issued and the banner must not say one was.
  it("does not claim a quotation was issued when the PASQ call itself throws", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
    vi.stubGlobal("fetch", fetchMock)

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <AgreementSection
          {...baseProps}
          agreementSignedAt={null}
          agreementGeneratedAt={null}
          agreementDocumentSha256={null}
          pasqDocumentSha256={null}
          pasqAcknowledged={false}
          signingKycBlockers={[]}
        />,
      )
    })

    await act(async () => {
      await renderer!.root.findByType("button").props.onClick()
    })

    const rendered = JSON.stringify(renderer!.toJSON())
    expect(rendered).not.toContain("The quotation was issued")
    expect(rendered).toContain("No quotation was issued")
    await act(async () => renderer!.unmount())
  })

  it("still reports the quotation as issued when only the agreement call throws", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documentSha256: "b".repeat(64) }) })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    vi.stubGlobal("fetch", fetchMock)

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <AgreementSection
          {...baseProps}
          agreementSignedAt={null}
          agreementGeneratedAt={null}
          agreementDocumentSha256={null}
          pasqDocumentSha256={null}
          pasqAcknowledged={false}
          signingKycBlockers={[]}
        />,
      )
    })

    await act(async () => {
      await renderer!.root.findByType("button").props.onClick()
    })

    const rendered = JSON.stringify(renderer!.toJSON())
    expect(rendered).toContain("The quotation was issued")
    expect(rendered).toContain("Do not send the quotation to the client for signature")
    await act(async () => renderer!.unmount())
  })

  it("keeps the half-prepared state on screen when the agreement call fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documentSha256: "b".repeat(64) }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "The client's KYC evidence does not meet the identity bar for a binding agreement.",
          remediation: "Capture a selfie or record an in-person verification on the client's KYC tab.",
        }),
      })
    vi.stubGlobal("fetch", fetchMock)

    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <AgreementSection
          {...baseProps}
          agreementSignedAt={null}
          agreementGeneratedAt={null}
          agreementDocumentSha256={null}
          pasqDocumentSha256={null}
          pasqAcknowledged={false}
          signingKycBlockers={[]}
        />,
      )
    })

    await act(async () => {
      await renderer!.root.findByType("button").props.onClick()
    })

    // A toast disappears. The quotation it left behind does not — and staff
    // sent that quotation out for signature because nothing on the page said
    // the agreement was missing.
    const rendered = JSON.stringify(renderer!.toJSON())
    expect(rendered).toContain("identity bar for a binding agreement")
    expect(rendered).toContain("Capture a selfie or record an in-person verification")
    expect(rendered).toContain("Do not send the quotation to the client for signature")
    await act(async () => renderer!.unmount())
  })
})

describe("AgreementSection countersign refusals", () => {
  async function countersignWith(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response))
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(<AgreementSection {...baseProps} />)
    })
    const attest = renderer!.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")[0]
    await act(async () => attest.props.onChange({ target: { checked: true } }))
    const button = renderer!.root.findAll((n) => n.type === "button" && nodeText(n.props.children).includes("Countersign Agreement"))[0]
    await act(async () => {
      await button.props.onClick()
    })
    const rendered = JSON.stringify(renderer!.toJSON())
    await act(async () => renderer!.unmount())
    return rendered
  }

  // Fair Score audit 2026-10-16: the countersign failed and the button "just
  // did nothing". A toast disappears; the reason must stay on screen.
  it("keeps the route's refusal on screen under the button", async () => {
    const rendered = await countersignWith({
      ok: false,
      status: 409,
      json: async () => ({ error: "The countersignature was refused: Signed debit-mandate authority is immutable outside an explicit return to review." }),
    })
    expect(rendered).toContain("Signed debit-mandate authority is immutable outside an explicit return to review")
  })

  it("says something readable when the response is not JSON", async () => {
    const rendered = await countersignWith({ ok: false, status: 500, json: async () => { throw new SyntaxError("Unexpected end of JSON input") } })
    expect(rendered).toContain("Countersign failed (HTTP 500)")
  })

  it("shows why this staff member cannot countersign instead of the form", () => {
    const html = renderToStaticMarkup(
      <AgreementSection
        {...baseProps}
        agreementSignedMethod="branch"
        countersignBlockedReason="Segregation of duties: you witnessed the client's in-branch signature, so another staff member must countersign for the lender."
      />,
    )
    expect(html).toContain("another staff member must countersign for the lender")
    expect(html).not.toContain("Countersign Agreement")
  })
})
